/**
 * Host-side RPC dispatcher for one host-authenticated plugin session.
 */
import type { PluginCapabilityFacade } from "../capabilities/broker.js";
import { parseRpcRequest, rpcFailure, rpcSuccess, RpcProtocolError, type RpcResponse, type RpcSettingValue } from "./protocol.js";
export interface PluginRpcSessionOptions {
  readonly facade: PluginCapabilityFacade;
  readonly maxConcurrentRequests?: number;
  readonly requestTimeoutMs?: number;
}
export class PluginRpcSession {
  readonly #facade: PluginCapabilityFacade;
  readonly #maxConcurrent: number;
  readonly #timeoutMs: number;
  readonly #seenRequestIds = new Set<string>();
  #inFlight = 0;
  constructor(options: PluginRpcSessionOptions) {
    this.#facade = options.facade;
    this.#maxConcurrent = options.maxConcurrentRequests ?? 8;
    this.#timeoutMs = options.requestTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.#maxConcurrent) || this.#maxConcurrent < 1 || this.#maxConcurrent > 64) throw new RangeError("maxConcurrentRequests must be an integer from 1 to 64.");
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 50 || this.#timeoutMs > 60_000) throw new RangeError("requestTimeoutMs must be an integer from 50 to 60000.");
  }
  get inFlightRequests(): number { return this.#inFlight; }
  async dispatch(input: unknown): Promise<RpcResponse> {
    let request;
    try { request = parseRpcRequest(input); }
    catch (error) {
      if (error instanceof RpcProtocolError) return rpcFailure("invalid", error.code, error.message);
      return rpcFailure("invalid", "INVALID_MESSAGE", "Unable to parse RPC request.");
    }
    if (this.#seenRequestIds.has(request.requestId)) return rpcFailure(request.requestId, "INVALID_MESSAGE", "Duplicate request ID.");
    if (this.#seenRequestIds.size >= 4096) return rpcFailure(request.requestId, "RATE_LIMITED", "RPC session request budget exhausted; create a new session.");
    this.#seenRequestIds.add(request.requestId);
    if (this.#inFlight >= this.#maxConcurrent) return rpcFailure(request.requestId, "RATE_LIMITED", "Too many concurrent plugin requests.");

    let operation: Promise<RpcSettingValue | null>;
    if (request.method === "capabilities.notifications.show") {
      const show = this.#facade.notifications?.show;
      if (!show) return rpcFailure(request.requestId, "CAPABILITY_DENIED", "ui.notifications is not available to this plugin.");
      operation = Promise.resolve().then(() => show(request.payload as { title: string; message: string })).then(() => null);
    } else {
      const settings = this.#facade.settings;
      if (!settings) return rpcFailure(request.requestId, "CAPABILITY_DENIED", "Plugin settings are not available to this plugin.");
      const payload = request.payload;
      operation = request.method === "settings.get"
        ? Promise.resolve().then(() => settings.get(payload.key as string, payload.defaultValue as RpcSettingValue))
        : Promise.resolve().then(() => settings.set(payload.key as string, payload.value as RpcSettingValue)).then(() => null);
    }
    this.#inFlight += 1;
    let timeout: ReturnType<typeof setTimeout> | undefined, didTimeout = false;
    const tracked = operation.finally(() => { this.#inFlight -= 1; });
    try {
      const timedOut = new Promise<never>((_, reject) => { timeout = setTimeout(() => { didTimeout = true; reject(new Error("RPC request timed out.")); }, this.#timeoutMs); });
      const result = await Promise.race([tracked, timedOut]);
      return rpcSuccess(request.requestId, result);
    } catch (error) {
      if (didTimeout) return rpcFailure(request.requestId, "REQUEST_TIMEOUT", "Capability operation exceeded its time limit.");
      if (error instanceof Error && error.name === "CapabilityDeniedError") return rpcFailure(request.requestId, "CAPABILITY_DENIED", "The host denied this capability.");
      return rpcFailure(request.requestId, "INTERNAL_ERROR", "Capability operation failed.");
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
  }
}
