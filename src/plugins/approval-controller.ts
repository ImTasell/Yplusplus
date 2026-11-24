/**
 * Host-owned plugin trust and permission workflow.
 *
 * Trust permits execution of one exact plugin release. Capability grants are
 * separate and remain least-privilege. Never expose these methods to plugins.
 */
import { CAPABILITIES } from "../capabilities/registry.js";
import { PluginApprovalStore, type ApprovalStoreOptions } from "../capabilities/approval-store.js";
import { PluginTrustStore, type PluginTrustStoreOptions } from "./trust-store.js";
import { inspectPlugins, type PluginManagerOptions, type PluginManagerReport } from "./manager.js";
import { checkPluginCompatibility, YPLUSPLUS_PLUGIN_API_VERSION } from "./compatibility.js";
import type { DiscoveredPlugin, PluginDiscoveryReport } from "./discovery.js";

export interface PluginApprovalControllerOptions {
  readonly store?: PluginApprovalStore;
  readonly storeOptions?: ApprovalStoreOptions;
  readonly trustStore?: PluginTrustStore;
  readonly trustStoreOptions?: PluginTrustStoreOptions;
  readonly hostApiVersion?: number;
}

export class PluginApprovalController {
  readonly store: PluginApprovalStore;
  readonly trustStore: PluginTrustStore;
  readonly hostApiVersion: number;

  constructor(options: PluginApprovalControllerOptions = {}) {
    this.store = options.store ?? new PluginApprovalStore(options.storeOptions);
    this.trustStore = options.trustStore ?? new PluginTrustStore(options.trustStoreOptions);
    this.hostApiVersion = options.hostApiVersion ?? YPLUSPLUS_PLUGIN_API_VERSION;
    if (!Number.isSafeInteger(this.hostApiVersion) || this.hostApiVersion < 1) throw new RangeError("Host API version must be a positive safe integer.");
  }

  inspect(discovery: PluginDiscoveryReport): Promise<PluginManagerReport> {
    const options: PluginManagerOptions = {
      hostApiVersion: this.hostApiVersion,
      isTrusted: (pluginId, pluginVersion) => this.trustStore.isTrusted(pluginId, pluginVersion),
      getApprovedPermissions: (pluginId, pluginVersion) => this.store.getApprovedPermissions(pluginId, pluginVersion),
    };
    return inspectPlugins(discovery, options);
  }

  /** Explicitly trust this exact release; this grants no capabilities. */
  async trust(plugin: DiscoveredPlugin): Promise<void> {
    const compatibility = checkPluginCompatibility(plugin.manifest, this.hostApiVersion);
    if (!compatibility.compatible) throw new Error(compatibility.failure.message);
    await this.trustStore.trust(plugin.manifest.id, plugin.manifest.version);
  }

  /** Revoke execution trust for this exact release. */
  untrust(pluginId: string, pluginVersion: string): Promise<void> {
    return this.trustStore.untrust(pluginId, pluginVersion);
  }

  /** Revoke execution trust for every release of a plugin. */
  untrustPlugin(pluginId: string): Promise<void> {
    return this.trustStore.untrustPlugin(pluginId);
  }

  /** Approve only requested, currently-supported capabilities for this release. */
  async approve(plugin: DiscoveredPlugin, capabilities: readonly string[]): Promise<void> {
    const manifest = plugin.manifest;
    const compatibility = checkPluginCompatibility(manifest, this.hostApiVersion);
    if (!compatibility.compatible) throw new Error(compatibility.failure.message);
    if (!Array.isArray(capabilities) || capabilities.length === 0) throw new TypeError("Select at least one capability to approve.");

    const requested = new Set(manifest.permissions);
    const unique = [...new Set(capabilities)];
    for (const id of unique) {
      if (typeof id !== "string" || !requested.has(id)) throw new Error(`Cannot approve ${String(id)}: the plugin did not request this capability.`);
      const definition = CAPABILITIES[id as keyof typeof CAPABILITIES];
      if (!definition || definition.apiVersion > manifest.apiVersion) throw new Error(`Cannot approve unsupported capability: ${id}.`);
    }
    await this.store.grantPermissions(manifest.id, manifest.version, unique);
  }

  revoke(pluginId: string, pluginVersion: string, capabilities?: readonly string[]): Promise<void> {
    return this.store.revokePermissions(pluginId, pluginVersion, capabilities);
  }

  revokePlugin(pluginId: string): Promise<void> {
    return this.store.revokePlugin(pluginId);
  }
}
