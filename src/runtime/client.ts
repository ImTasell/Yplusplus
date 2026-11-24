/**
 * Plugin-side, capability-only Y++ API client.
 *
 * This module is safe to bundle into a plugin renderer: it imports no Node or
 * Electron APIs and exposes only the methods represented by the RPC protocol.
 */
import type { RpcMessagePort } from "./message-port.js";
import {
  YPLUSPLUS_RPC_VERSION,
  type RpcResponse,
} from "./protocol.js";

export interface PluginApiClientOptions {
  readonly requestTimeoutMs?: number;
  readonly maxPendingRequests?: number;
}

export interface PluginApi {
  readonly notifications: {
    show(request: { readonly title: string; readonly message: string }): Promise<void>;
  };
  close(): void;
}

export class PluginApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PluginApiError";
    this.code = code;
  }
}

interface PendingRequest {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

function isResponse(value: unknown): value is RpcResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.rpcVersion !== YPLUSPLUS_RPC_VERSION ||
      candidate.type !== "response" ||
      typeof candidate.requestId !== "string" ||
      typeof candidate.ok !== "boolean") return false;
  if (candidate.ok) return candidate.result === null;
  if (typeof candidate.error !== "object" || candidate.error === null) return false;
  const error = candidate.error as Record<string, unknown>;
  return typeof error.code === "string" && typeof error.message === "string";
}

export function createPluginApiClient(
  port: RpcMessagePort,
  options: PluginApiClientOptions = {},
): PluginApi {
  const timeoutMs = options.requestTimeoutMs ?? 10_000;
  const maxPending = options.maxPendingRequests ?? 32;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 120_000) {
    throw new RangeError("requestTimeoutMs must be an integer from 50 to 120000.");
  }
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 256) {
    throw new RangeError("maxPendingRequests must be an integer from 1 to 256.");
  }

  const pending = new Map<string, PendingRequest>();
  let nextId = 0;
  let closed = false;

  const onMessage = (event: { readonly data: unknown }): void => {
    if (!isResponse(event.data)) return;
    const item = pending.get(event.data.requestId);
    if (!item) return;
    pending.delete(event.data.requestId);
    clearTimeout(item.timeout);
    if (event.data.ok) {
      item.resolve();
    } else {
      item.reject(new PluginApiError(event.data.error.code, event.data.error.message));
    }
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    port.removeEventListener("message", onMessage);
    for (const item of pending.values()) {
      clearTimeout(item.timeout);
      item.reject(new PluginApiError("SESSION_CLOSED", "The Y++ plugin session is closed."));
    }
    pending.clear();
  };

  const request = (title: string, message: string): Promise<void> => {
    if (closed) return Promise.reject(new PluginApiError("SESSION_CLOSED", "The Y++ plugin session is closed."));
    if (pending.size >= maxPending) {
      return Promise.reject(new PluginApiError("RATE_LIMITED", "Too many pending Y++ API requests."));
    }
    const requestId = `p${++nextId}`;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new PluginApiError("REQUEST_TIMEOUT", "The Y++ host did not respond in time."));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timeout });
      try {
        port.postMessage({
          rpcVersion: YPLUSPLUS_RPC_VERSION,
          type: "request",
          requestId,
          method: "capabilities.notifications.show",
          payload: { title, message },
        });
      } catch {
        pending.delete(requestId);
        clearTimeout(timeout);
        reject(new PluginApiError("TRANSPORT_ERROR", "Could not send the Y++ API request."));
      }
    });
  };

  port.addEventListener("message", onMessage);
  port.start();

  return Object.freeze({
    notifications: Object.freeze({
      show: (input: { readonly title: string; readonly message: string }) => {
        if (typeof input !== "object" || input === null ||
            typeof input.title !== "string" || typeof input.message !== "string") {
          return Promise.reject(new PluginApiError("INVALID_ARGUMENT", "Expected string title and message."));
        }
        return request(input.title, input.message);
      },
    }),
    close,
  });
}
