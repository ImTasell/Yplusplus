/**
 * Host-owned plugin runtime coordinator.
 *
 * Execution and channel creation are injected adapters so the core does not
 * assume Node Worker is a security boundary. Production adapters must provide
 * an actually sandboxed execution environment and transfer only the plugin
 * endpoint to it.
 */
import type { ManagedPlugin } from "../plugins/manager.js";
import { transitionPluginState, type PluginState } from "../plugins/lifecycle.js";
import { bindRpcMessagePort, type RpcMessagePort, type RpcPortTransport } from "./message-port.js";
import type { PluginRpcSession } from "./rpc-session.js";

export interface PluginMessageChannel {
  readonly hostPort: RpcMessagePort;
  readonly pluginPort: RpcMessagePort;
}

export interface PluginExecutionHandle {
  /** Terminate the isolated execution context and wait for it to stop. */
  terminate(): Promise<void>;
  /** Subscribe to unexpected isolated runtime exit/crash. */
  onExit(listener: (reason?: unknown) => void): () => void;
}

export interface PluginExecutionAdapter {
  /**
   * Start the plugin and resolve only after its entry has initialized.
   * The adapter must transfer pluginPort into the isolated context.
   */
  start(plugin: Pick<ManagedPlugin, "id" | "name" | "version" | "directory" | "requestedPermissions" | "compatibility" | "entry">,
    pluginPort: RpcMessagePort, signal?: AbortSignal): Promise<PluginExecutionHandle>;
}

export interface PluginRuntimeOptions {
  readonly createChannel: () => PluginMessageChannel;
  readonly createSession: (plugin: ManagedPlugin) => PluginRpcSession | Promise<PluginRpcSession>;
  readonly execution: PluginExecutionAdapter;
  readonly startupTimeoutMs?: number;
}

export interface PluginRuntimeSnapshot {
  readonly id: string;
  readonly version: string;
  readonly state: PluginState;
}

interface RuntimeRecord {
  readonly plugin: ManagedPlugin;
  state: PluginState;
  readonly transport: RpcPortTransport;
  readonly pluginPort: RpcMessagePort;
  readonly abortController: AbortController;
  handle?: PluginExecutionHandle;
  unsubscribeExit?: () => void;
  starting: boolean;
}

function move(record: RuntimeRecord, next: PluginState): void {
  const result = transitionPluginState(record.state, next);
  if (!result.ok) throw new Error(result.message);
  record.state = result.to;
}

export class PluginRuntimeHost {
  readonly #options: PluginRuntimeOptions;
  readonly #records = new Map<string, RuntimeRecord>();
  readonly #startupTimeoutMs: number;

  constructor(options: PluginRuntimeOptions) {
    this.#options = options;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.#startupTimeoutMs) ||
        this.#startupTimeoutMs < 100 || this.#startupTimeoutMs > 120_000) {
      throw new RangeError("startupTimeoutMs must be an integer from 100 to 120000.");
    }
  }

  get(id: string): PluginRuntimeSnapshot | undefined {
    const record = this.#records.get(id);
    return record ? Object.freeze({
      id: record.plugin.id,
      version: record.plugin.version,
      state: record.state,
    }) : undefined;
  }

  list(): readonly PluginRuntimeSnapshot[] {
    return Object.freeze([...this.#records.values()].map((record) => Object.freeze({
      id: record.plugin.id,
      version: record.plugin.version,
      state: record.state,
    })));
  }

  async start(plugin: ManagedPlugin): Promise<PluginRuntimeSnapshot> {
    if (plugin.state !== "READY" || plugin.trusted !== true || !plugin.compatibility.compatible) {
      throw new Error("Only compatible READY plugins may be started.");
    }
    const existing = this.#records.get(plugin.id);
    if (existing && existing.state !== "UNLOADED" && existing.state !== "FAILED") {
      throw new Error("Plugin already has an active or starting runtime.");
    }
    if (existing && existing.state === "FAILED") {
      await this.unload(plugin.id);
    }

    const channel = this.#options.createChannel();
    let transport: RpcPortTransport;
    try {
      let sessionTimeout: ReturnType<typeof setTimeout> | undefined;
      const sessionPromise = Promise.resolve(this.#options.createSession(plugin));
      const sessionTimedOut = new Promise<never>((_, reject) => {
        sessionTimeout = setTimeout(() => reject(new Error("Plugin session setup timed out.")), this.#startupTimeoutMs);
      });
      let session: PluginRpcSession;
      try {
        session = await Promise.race([sessionPromise, sessionTimedOut]);
      } finally {
        if (sessionTimeout !== undefined) clearTimeout(sessionTimeout);
      }
      transport = bindRpcMessagePort(channel.hostPort, session);
    } catch (error) {
      channel.hostPort.close();
      channel.pluginPort.close();
      throw error;
    }
    const abortController = new AbortController();
    const record: RuntimeRecord = {
      plugin,
      state: "READY",
      transport,
      pluginPort: channel.pluginPort,
      abortController,
      starting: true,
    };
    this.#records.set(plugin.id, record);
    move(record, "INITIALIZING");

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      let startupTimedOut = false;
      const startup = this.#options.execution.start({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        directory: plugin.directory,
        requestedPermissions: plugin.requestedPermissions,
        compatibility: plugin.compatibility,
        ...(plugin.entry === undefined ? {} : { entry: plugin.entry }),
      }, channel.pluginPort, abortController.signal);
      void startup.then((lateHandle) => {
        if (startupTimedOut) void lateHandle.terminate();
      }, () => undefined);
      const timedOut = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          startupTimedOut = true;
          reject(new Error("Plugin startup timed out."));
        }, this.#startupTimeoutMs);
      });
      const handle = await Promise.race([startup, timedOut]);
      if (record.state !== "INITIALIZING") {
        await handle.terminate();
        throw new Error("Plugin runtime stopped during initialization.");
      }
      record.handle = handle;
      record.unsubscribeExit = handle.onExit(() => {
        if (record.state === "ACTIVE" || record.state === "INITIALIZING") {
          void this.#fail(record);
        }
      });
      if (record.state !== "INITIALIZING") {
        throw new Error("Plugin exited during initialization.");
      }
      move(record, "ACTIVE");
      record.starting = false;
      return this.get(plugin.id)!;
    } catch (error) {
      record.starting = false;
      await this.#fail(record);
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async unload(id: string): Promise<PluginRuntimeSnapshot | undefined> {
    const record = this.#records.get(id);
    if (!record) return undefined;
    if (record.state === "UNLOADED") return this.get(id);
    if (record.state !== "UNLOADING") move(record, "UNLOADING");
    await this.#dispose(record);
    move(record, "UNLOADED");
    return this.get(id);
  }

  async #fail(record: RuntimeRecord): Promise<void> {
    if (record.state === "FAILED" || record.state === "UNLOADED") return;
    if (record.state !== "UNLOADING") move(record, "FAILED");
    await this.#dispose(record);
  }

  async #dispose(record: RuntimeRecord): Promise<void> {
    record.abortController.abort();
    record.transport.close();
    record.pluginPort.close();
    record.unsubscribeExit?.();
    delete record.unsubscribeExit;
    const handle = record.handle;
    delete record.handle;
    if (handle) {
      try { await handle.terminate(); } catch { /* termination is best-effort after channel revocation */ }
    }
  }
}
