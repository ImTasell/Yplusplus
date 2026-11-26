import { PluginApprovalController } from "../plugins/approval-controller.js";
import { discoverPlugins } from "../plugins/discovery.js";
import type { ManagedPlugin } from "../plugins/manager.js";
import type { PluginRuntimeHost } from "./host.js";
import type { PluginEnabledStore } from "../plugins/plugin-enabled-store.js";

export interface PluginManagerServiceOptions {
  readonly pluginRoot: string;
  readonly approvals: PluginApprovalController;
  readonly runtime: PluginRuntimeHost;
  readonly enabledStore?: PluginEnabledStore;
}

export interface PluginManagerPluginView {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly state: string;
  readonly trusted: boolean;
  readonly enabled: boolean;
  readonly requestedPermissions: readonly string[];
  readonly approvedPermissions: readonly string[];
  readonly deniedPermissions: ManagedPlugin["deniedPermissions"];
  readonly compatibility: ManagedPlugin["compatibility"];
  readonly issue?: ManagedPlugin["issue"];
  readonly runtimeState?: string;
}

export interface PluginManagerSnapshot {
  readonly plugins: readonly PluginManagerPluginView[];
  readonly rejected: readonly {
    readonly directory: string;
    readonly issues: readonly { readonly code: string; readonly message: string }[];
  }[];
}

function validateIdentity(id: unknown, version: unknown): readonly [string, string] {
  if (typeof id !== "string" || typeof version !== "string" ||
      id.length > 128 || version.length > 128) {
    throw new TypeError("A valid plugin ID and exact version are required.");
  }
  return [id, version];
}

export class PluginManagerService {
  readonly #options: PluginManagerServiceOptions;

  constructor(options: PluginManagerServiceOptions) {
    this.#options = options;
  }

  async #discover() {
    return discoverPlugins(this.#options.pluginRoot);
  }

  async #find(id: string, version: string) {
    const discovery = await this.#discover();
    const plugin = discovery.plugins.find((item) =>
      item.manifest.id === id && item.manifest.version === version);
    if (!plugin) throw new Error(`No discovered plugin matches ${id}@${version}.`);
    return plugin;
  }

  async #startIfReady(plugin: ManagedPlugin): Promise<void> {
    if (plugin.state !== "READY" || plugin.trusted !== true) return;
    if (this.#options.enabledStore && !(await this.#options.enabledStore.isEnabled(plugin.id))) return;
    const current = this.#options.runtime.get(plugin.id);
    if (current && current.state !== "UNLOADED" && current.state !== "FAILED") return;
    await this.#options.runtime.start(plugin);
  }

  async refresh(): Promise<PluginManagerSnapshot> {
    const discovery = await this.#discover();
    const report = await this.#options.approvals.inspect(discovery);
    const runtime = new Map(this.#options.runtime.list().map((item) => [item.id, item]));
    const plugins = await Promise.all(report.plugins.map(async (plugin) => {
      const runtimeState = runtime.get(plugin.id)?.state;
      const enabled = this.#options.enabledStore
        ? await this.#options.enabledStore.isEnabled(plugin.id)
        : true;
      return Object.freeze({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        state: plugin.state,
        trusted: plugin.trusted === true,
        enabled,
        requestedPermissions: plugin.requestedPermissions,
        approvedPermissions: plugin.approvedPermissions,
        deniedPermissions: plugin.deniedPermissions,
        compatibility: plugin.compatibility,
        ...(plugin.issue ? { issue: plugin.issue } : {}),
        ...(runtimeState ? { runtimeState } : {}),
      });
    }));
    return Object.freeze({
      plugins: Object.freeze(plugins),
      rejected: Object.freeze(discovery.rejected.map((item) => Object.freeze({
        directory: item.directory,
        issues: Object.freeze(item.issues.map((issue) => Object.freeze({
          code: issue.code,
          message: issue.message,
        }))),
      }))),
    });
  }

  async setEnabled(id: unknown, version: unknown, enabled: unknown): Promise<PluginManagerSnapshot> {
    const [pluginId, pluginVersion] = validateIdentity(id, version);
    if (typeof enabled !== "boolean") throw new TypeError("Plugin enabled state must be boolean.");
    if (!this.#options.enabledStore) throw new Error("Persistent plugin enable state is unavailable.");
    await this.#find(pluginId, pluginVersion);
    await this.#options.enabledStore.setEnabled(pluginId, enabled);
    if (enabled) {
      const report = await this.#options.approvals.inspect(await this.#discover());
      const ready = report.plugins.find((item) => item.id === pluginId && item.version === pluginVersion);
      if (ready) await this.#startIfReady(ready);
    } else {
      await this.#options.runtime.unload(pluginId);
    }
    return this.refresh();
  }

  async trust(id: unknown, version: unknown): Promise<PluginManagerSnapshot> {
    const [pluginId, pluginVersion] = validateIdentity(id, version);
    const plugin = await this.#find(pluginId, pluginVersion);
    await this.#options.approvals.trust(plugin);
    const report = await this.#options.approvals.inspect(await this.#discover());
    const ready = report.plugins.find((item) => item.id === pluginId && item.version === pluginVersion);
    if (ready) await this.#startIfReady(ready);
    return this.refresh();
  }

  async untrust(id: unknown, version: unknown): Promise<PluginManagerSnapshot> {
    const [pluginId, pluginVersion] = validateIdentity(id, version);
    await this.#options.approvals.untrust(pluginId, pluginVersion);
    await this.#options.runtime.unload(pluginId);
    return this.refresh();
  }

  async approve(id: unknown, version: unknown, capabilities: unknown): Promise<PluginManagerSnapshot> {
    const [pluginId, pluginVersion] = validateIdentity(id, version);
    if (!Array.isArray(capabilities) || capabilities.length === 0 ||
        capabilities.some((item) => typeof item !== "string" || item.length > 128)) {
      throw new TypeError("Select at least one requested capability.");
    }
    const plugin = await this.#find(pluginId, pluginVersion);
    await this.#options.approvals.approve(plugin, capabilities as string[]);
    const report = await this.#options.approvals.inspect(await this.#discover());
    const ready = report.plugins.find((item) => item.id === pluginId && item.version === pluginVersion);
    if (ready) await this.#startIfReady(ready);
    return this.refresh();
  }

  async revoke(id: unknown, version: unknown, capabilities?: unknown): Promise<PluginManagerSnapshot> {
    const [pluginId, pluginVersion] = validateIdentity(id, version);
    if (capabilities !== undefined && (!Array.isArray(capabilities) ||
        capabilities.some((item) => typeof item !== "string" || item.length > 128))) {
      throw new TypeError("Invalid capability selection.");
    }
    await this.#options.approvals.revoke(pluginId, pluginVersion, capabilities as string[] | undefined);
    return this.refresh();
  }

  async unload(id: unknown, version: unknown): Promise<PluginManagerSnapshot> {
    const [pluginId, pluginVersion] = validateIdentity(id, version);
    const plugin = await this.#find(pluginId, pluginVersion);
    await this.#options.runtime.unload(plugin.manifest.id);
    return this.refresh();
  }

  async start(id: unknown, version: unknown): Promise<PluginManagerSnapshot> {
    const [pluginId, pluginVersion] = validateIdentity(id, version);
    const report = await this.#options.approvals.inspect(await this.#discover());
    const plugin = report.plugins.find((item) => item.id === pluginId && item.version === pluginVersion);
    if (!plugin) throw new Error(`No discovered plugin matches ${pluginId}@${pluginVersion}.`);
    if (plugin.state !== "READY" || plugin.trusted !== true) {
      throw new Error("Only trusted, fully approved plugins can be started.");
    }
    if (this.#options.enabledStore && !(await this.#options.enabledStore.isEnabled(pluginId))) {
      throw new Error("This plugin is disabled. Enable it from the Plugins page first.");
    }
    await this.#startIfReady(plugin);
    return this.refresh();
  }
}
