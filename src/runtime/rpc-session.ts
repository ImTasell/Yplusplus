/**
 * Host-side RPC dispatcher for one host-authenticated plugin session.
 */
import type { PluginCapabilityFacade } from "../capabilities/broker.js";
import { parseRpcRequest, rpcFailure, rpcSuccess, RpcProtocolError, YPLUSPLUS_RPC_VERSION, type RpcResponse, type RpcSettingValue, type RpcPluginEvent } from "./protocol.js";
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
  readonly #subscriptions = new Map<string, () => void>();
  readonly #panelDisposers = new Map<string, () => void>();
  #eventSink: ((event: RpcPluginEvent) => void) | undefined;
  #closed = false;
  constructor(options: PluginRpcSessionOptions) {
    this.#facade = options.facade;
    this.#maxConcurrent = options.maxConcurrentRequests ?? 8;
    this.#timeoutMs = options.requestTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.#maxConcurrent) || this.#maxConcurrent < 1 || this.#maxConcurrent > 64) throw new RangeError("maxConcurrentRequests must be an integer from 1 to 64.");
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 50 || this.#timeoutMs > 60_000) throw new RangeError("requestTimeoutMs must be an integer from 50 to 60000.");
  }
  get inFlightRequests(): number { return this.#inFlight; }
  setEventSink(sink: ((event: RpcPluginEvent) => void) | undefined): void { this.#eventSink = sink; }\n  emitApplicationReady(timestamp: number): void {\n    if (this.#closed || !this.#eventSink || !Number.isFinite(timestamp)) return;\n    try { this.#eventSink(Object.freeze({ rpcVersion: YPLUSPLUS_RPC_VERSION, type: "event", event: "application.ready", payload: Object.freeze({ timestamp }) })); }\n    catch { /* transport closure is handled by its owner */ }\n  }
  close(): void { if (this.#closed) return; this.#closed = true; this.#eventSink = undefined; for (const dispose of this.#subscriptions.values()) dispose(); this.#subscriptions.clear(); for (const dispose of this.#panelDisposers.values()) dispose(); this.#panelDisposers.clear(); }
  async dispatch(input: unknown): Promise<RpcResponse> {
    let request;
    try { request = parseRpcRequest(input); }
    catch (error) {
      if (error instanceof RpcProtocolError) return rpcFailure("invalid", error.code, error.message);
      return rpcFailure("invalid", "INVALID_MESSAGE", "Unable to parse RPC request.");
    }
    if (this.#closed) return rpcFailure(request.requestId, "CAPABILITY_DENIED", "The plugin RPC session is closed.");
    if (this.#seenRequestIds.has(request.requestId)) return rpcFailure(request.requestId, "INVALID_MESSAGE", "Duplicate request ID.");
    if (this.#seenRequestIds.size >= 4096) return rpcFailure(request.requestId, "RATE_LIMITED", "RPC session request budget exhausted; create a new session.");
    this.#seenRequestIds.add(request.requestId);
    if (this.#inFlight >= this.#maxConcurrent) return rpcFailure(request.requestId, "RATE_LIMITED", "Too many concurrent plugin requests.");

    if (request.method === "ui.settingsPanel.register" || request.method === "ui.settingsPanel.unregister") {
      const ui = this.#facade.ui;
      if (!ui) return rpcFailure(request.requestId, "CAPABILITY_DENIED", "Plugin settings panels are not available to this plugin.");
      try {
        if (request.method === "ui.settingsPanel.register") {
          const panel = request.payload.panel as Record<string, unknown>;
          const panelId = panel.id as string;
          if (this.#panelDisposers.has(panelId)) return rpcFailure(request.requestId, "INVALID_MESSAGE", "This plugin already registered that settings panel ID.");
          const dispose = ui.registerSettingsPanel(panel as never);
          this.#panelDisposers.set(panelId, dispose);
        } else {
          const panelId = request.payload.panelId as string;
          this.#panelDisposers.get(panelId)?.();
          this.#panelDisposers.delete(panelId);
        }
        return rpcSuccess(request.requestId);
      } catch {
        return rpcFailure(request.requestId, "INVALID_MESSAGE", "The settings panel definition was rejected by the host.");
      }
    }
    if (request.method === "settings.subscribe" || request.method === "settings.unsubscribe") {
      const settings = this.#facade.settings;
      if (!settings) return rpcFailure(request.requestId, "CAPABILITY_DENIED", "Plugin settings are not available to this plugin.");
      const key = request.payload.key as string;
      if (request.method === "settings.subscribe") {
        if (!this.#subscriptions.has(key)) {
          const dispose = settings.subscribe(key, (value) => {
            if (this.#closed || !this.#eventSink) return;
            try {
              this.#eventSink(Object.freeze({
                rpcVersion: YPLUSPLUS_RPC_VERSION, type: "event", event: "settings.change",
                payload: Object.freeze({ key, value }),
              }));
            } catch { /* transport closure is handled by its owner */ }
          });
          this.#subscriptions.set(key, dispose);
        }
      } else {
        this.#subscriptions.get(key)?.();
        this.#subscriptions.delete(key);
      }
      return rpcSuccess(request.requestId);
    }

    let operation: Promise<RpcSettingValue | null>;
    if (request.method === "audio.playStartup") {\n      const playStartup = this.#facade.audio?.playStartup;\n      if (!playStartup) return rpcFailure(request.requestId, "CAPABILITY_DENIED", "Startup audio is not available to this plugin.");\n      operation = Promise.resolve().then(() => playStartup()).then(() => null);\n    } else if (request.method === "capabilities.notifications.show") {
      const show = this.#facade.notifications?.show;
      if (!show) return rpcFailure(request.requestId, "CAPABILITY_DENIED", "ui.notifications is not available to this plugin.");
      operation = Promise.resolve().then(() => show({ title: request.payload.title as string, message: request.payload.message as string })).then(() => null);
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
