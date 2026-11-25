/**
 * Plugin-side, capability-only Y++ API client. No Node/Electron imports.
 */
import type { RpcMessagePort } from "./message-port.js";
import { YPLUSPLUS_RPC_VERSION, type RpcResponse, type RpcSettingValue, type RpcSettingsChangeEvent } from "./protocol.js";
export interface PluginApiClientOptions { readonly requestTimeoutMs?: number; readonly maxPendingRequests?: number; }
export interface PluginApi {
  readonly notifications: { show(request: { readonly title: string; readonly message: string }): Promise<void>; };
  readonly settings: {
    get<T extends RpcSettingValue>(key: string, defaultValue: T): Promise<T>;
    set<T extends RpcSettingValue>(key: string, value: T): Promise<void>;
    onChange<T extends RpcSettingValue>(key: string, listener: (value: T) => void): () => void;
  };
  close(): void;
}
export class PluginApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "PluginApiError"; this.code = code; }
}
interface PendingRequest { readonly resolve: (value: RpcSettingValue | null) => void; readonly reject: (error: Error) => void; readonly timeout: ReturnType<typeof setTimeout>; }
function isResponse(value: unknown): value is RpcResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (c.rpcVersion !== YPLUSPLUS_RPC_VERSION || c.type !== "response" || typeof c.requestId !== "string" || typeof c.ok !== "boolean") return false;
  if (c.ok) return c.result === null || typeof c.result === "string" || typeof c.result === "boolean" || (typeof c.result === "number" && Number.isFinite(c.result));
  if (typeof c.error !== "object" || c.error === null) return false;
  const e = c.error as Record<string, unknown>;
  return typeof e.code === "string" && typeof e.message === "string";
}
function isSettingsEvent(value: unknown): value is RpcSettingsChangeEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (c.rpcVersion !== YPLUSPLUS_RPC_VERSION || c.type !== "event" || c.event !== "settings.change" ||
      typeof c.payload !== "object" || c.payload === null || Array.isArray(c.payload)) return false;
  const p = c.payload as Record<string, unknown>;
  const keys = Object.keys(p).sort().join(",");
  return keys === "key,value" && typeof p.key === "string" &&
    (typeof p.value === "string" || typeof p.value === "boolean" || (typeof p.value === "number" && Number.isFinite(p.value)));
}
export function createPluginApiClient(port: RpcMessagePort, options: PluginApiClientOptions = {}): PluginApi {
  const timeoutMs = options.requestTimeoutMs ?? 10_000, maxPending = options.maxPendingRequests ?? 32;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 120_000) throw new RangeError("requestTimeoutMs must be an integer from 50 to 120000.");
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 256) throw new RangeError("maxPendingRequests must be an integer from 1 to 256.");
  const pending = new Map<string, PendingRequest>();
  const listeners = new Map<string, Set<(value: RpcSettingValue) => void>>();
  const subscribed = new Set<string>();
  let nextId = 0, closed = false;
  const request = (method: string, payload: Record<string, unknown>): Promise<RpcSettingValue | null> => {
    if (closed) return Promise.reject(new PluginApiError("SESSION_CLOSED", "The Y++ plugin session is closed."));
    if (pending.size >= maxPending) return Promise.reject(new PluginApiError("RATE_LIMITED", "Too many pending Y++ API requests."));
    const requestId = `p${++nextId}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(requestId); reject(new PluginApiError("REQUEST_TIMEOUT", "The Y++ host did not respond in time.")); }, timeoutMs);
      pending.set(requestId, { resolve, reject, timeout });
      try { port.postMessage({ rpcVersion: YPLUSPLUS_RPC_VERSION, type: "request", requestId, method, payload }); }
      catch { pending.delete(requestId); clearTimeout(timeout); reject(new PluginApiError("TRANSPORT_ERROR", "Could not send the Y++ API request.")); }
    });
  };
  const onMessage = (event: { readonly data: unknown }): void => {
    if (isResponse(event.data)) {
      const item = pending.get(event.data.requestId);
      if (!item) return;
      pending.delete(event.data.requestId); clearTimeout(item.timeout);
      if (event.data.ok) item.resolve(event.data.result);
      else item.reject(new PluginApiError(event.data.error.code, event.data.error.message));
      return;
    }
    if (isSettingsEvent(event.data)) {
      const callbacks = listeners.get(event.data.payload.key);
      for (const callback of [...(callbacks ?? [])]) {
        try { callback(event.data.payload.value); } catch { /* plugin listener failures are isolated */ }
      }
    }
  };
  const close = (): void => {
    if (closed) return; closed = true; port.removeEventListener("message", onMessage);
    for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(new PluginApiError("SESSION_CLOSED", "The Y++ plugin session is closed.")); }
    pending.clear(); listeners.clear(); subscribed.clear();
  };
  const validKey = (key: string): void => {
    if (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) throw new PluginApiError("INVALID_ARGUMENT", "Invalid setting key.");
  };
  const settings = Object.freeze({
    get: async <T extends RpcSettingValue>(key: string, defaultValue: T): Promise<T> => {
      validKey(key);
      const result = await request("settings.get", { key, defaultValue });
      return result as T;
    },
    set: async <T extends RpcSettingValue>(key: string, value: T): Promise<void> => {
      validKey(key); await request("settings.set", { key, value });
    },
    onChange: <T extends RpcSettingValue>(key: string, listener: (value: T) => void): (() => void) => {
      validKey(key);
      if (typeof listener !== "function") throw new PluginApiError("INVALID_ARGUMENT", "A settings listener is required.");
      if (closed) throw new PluginApiError("SESSION_CLOSED", "The Y++ plugin session is closed.");
      let callbacks = listeners.get(key);
      if (!callbacks) { callbacks = new Set(); listeners.set(key, callbacks); }
      callbacks.add(listener as (value: RpcSettingValue) => void);
      if (callbacks.size === 1) {
        void request("settings.subscribe", { key }).then(() => {
          subscribed.add(key);
          if (!listeners.has(key) && !closed) {
            subscribed.delete(key);
            void request("settings.unsubscribe", { key }).catch(() => undefined);
          }
        }).catch(() => {
          callbacks?.delete(listener as (value: RpcSettingValue) => void);
          if (callbacks?.size === 0) listeners.delete(key);
        });
      }
      let active = true;
      return () => {
        if (!active) return; active = false;
        const current = listeners.get(key);
        current?.delete(listener as (value: RpcSettingValue) => void);
        if (current?.size === 0) {
          listeners.delete(key);
          if (subscribed.delete(key) && !closed) void request("settings.unsubscribe", { key }).catch(() => undefined);
        }
      };
    },
  });
  port.addEventListener("message", onMessage); port.start();
  return Object.freeze({
    notifications: Object.freeze({ show: (input: { readonly title: string; readonly message: string }) => {
      if (typeof input !== "object" || input === null || typeof input.title !== "string" || typeof input.message !== "string") return Promise.reject(new PluginApiError("INVALID_ARGUMENT", "Expected string title and message."));
      return request("capabilities.notifications.show", { title: input.title, message: input.message }).then(() => undefined);
    } }),
    settings,
    close,
  });
}
