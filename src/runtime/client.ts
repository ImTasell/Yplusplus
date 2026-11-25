/**
 * Plugin-side, capability-only Y++ API client. No Node/Electron imports.
 */
import type { RpcMessagePort } from "./message-port.js";
import { YPLUSPLUS_RPC_VERSION, type RpcResponse, type RpcSettingValue } from "./protocol.js";
export interface PluginApiClientOptions { readonly requestTimeoutMs?: number; readonly maxPendingRequests?: number; }
export interface PluginApi {
  readonly notifications: { show(request: { readonly title: string; readonly message: string }): Promise<void>; };
  readonly settings: {
    get<T extends RpcSettingValue>(key: string, defaultValue: T): Promise<T>;
    set<T extends RpcSettingValue>(key: string, value: T): Promise<void>;
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
export function createPluginApiClient(port: RpcMessagePort, options: PluginApiClientOptions = {}): PluginApi {
  const timeoutMs = options.requestTimeoutMs ?? 10_000, maxPending = options.maxPendingRequests ?? 32;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 120_000) throw new RangeError("requestTimeoutMs must be an integer from 50 to 120000.");
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 256) throw new RangeError("maxPendingRequests must be an integer from 1 to 256.");
  const pending = new Map<string, PendingRequest>();
  let nextId = 0, closed = false;
  const onMessage = (event: { readonly data: unknown }): void => {
    if (!isResponse(event.data)) return;
    const item = pending.get(event.data.requestId);
    if (!item) return;
    pending.delete(event.data.requestId); clearTimeout(item.timeout);
    if (event.data.ok) item.resolve(event.data.result);
    else item.reject(new PluginApiError(event.data.error.code, event.data.error.message));
  };
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
  const close = (): void => {
    if (closed) return; closed = true; port.removeEventListener("message", onMessage);
    for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(new PluginApiError("SESSION_CLOSED", "The Y++ plugin session is closed.")); }
    pending.clear();
  };
  port.addEventListener("message", onMessage); port.start();
  return Object.freeze({
    notifications: Object.freeze({ show: (input: { readonly title: string; readonly message: string }) => {
      if (typeof input !== "object" || input === null || typeof input.title !== "string" || typeof input.message !== "string") return Promise.reject(new PluginApiError("INVALID_ARGUMENT", "Expected string title and message."));
      return request("capabilities.notifications.show", { title: input.title, message: input.message }).then(() => undefined);
    } }),
    settings: Object.freeze({
      get: async <T extends RpcSettingValue>(key: string, defaultValue: T): Promise<T> => {
        if (typeof key !== "string" || key.length < 1 || key.length > 128) throw new PluginApiError("INVALID_ARGUMENT", "Invalid setting key.");
        const result = await request("settings.get", { key, defaultValue });
        return result as T;
      },
      set: async <T extends RpcSettingValue>(key: string, value: T): Promise<void> => {
        if (typeof key !== "string" || key.length < 1 || key.length > 128) throw new PluginApiError("INVALID_ARGUMENT", "Invalid setting key.");
        await request("settings.set", { key, value });
      },
    }),
    close,
  });
}
