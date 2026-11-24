/**
 * Host-owned plugin permission workflow.
 *
 * This controller is intended to be called by trusted Y++ host UI/commands.
 * Never expose approve() or revoke() directly to plugin code.
 */
import { CAPABILITIES } from "../capabilities/registry.js";
import {
  PluginApprovalStore,
  type ApprovalStoreOptions,
} from "../capabilities/approval-store.js";
import { inspectPlugins, type PluginManagerOptions, type PluginManagerReport } from "./manager.js";
import { checkPluginCompatibility, YPLUSPLUS_PLUGIN_API_VERSION } from "./compatibility.js";
import type { DiscoveredPlugin, PluginDiscoveryReport } from "./discovery.js";

export interface PluginApprovalControllerOptions {
  readonly store?: PluginApprovalStore;
  readonly storeOptions?: ApprovalStoreOptions;
  readonly hostApiVersion?: number;
}

export class PluginApprovalController {
  readonly store: PluginApprovalStore;
  readonly hostApiVersion: number;

  constructor(options: PluginApprovalControllerOptions = {}) {
    this.store = options.store ?? new PluginApprovalStore(options.storeOptions);
    this.hostApiVersion = options.hostApiVersion ?? YPLUSPLUS_PLUGIN_API_VERSION;
    if (!Number.isSafeInteger(this.hostApiVersion) || this.hostApiVersion < 1) {
      throw new RangeError("Host API version must be a positive safe integer.");
    }
  }

  /** Inspect discovery results using persistent host-owned approvals. */
  inspect(discovery: PluginDiscoveryReport): Promise<PluginManagerReport> {
    const options: PluginManagerOptions = {
      hostApiVersion: this.hostApiVersion,
      getApprovedPermissions: (pluginId, pluginVersion) =>
        this.store.getApprovedPermissions(pluginId, pluginVersion),
    };
    return inspectPlugins(discovery, options);
  }

  /**
   * Explicitly approve a subset of this plugin release's requested,
   * currently-supported capabilities. Unknown and unrequested grants fail.
   */
  async approve(plugin: DiscoveredPlugin, capabilities: readonly string[]): Promise<void> {
    const manifest = plugin.manifest;
    const compatibility = checkPluginCompatibility(manifest, this.hostApiVersion);
    if (!compatibility.compatible) {
      throw new Error(compatibility.failure.message);
    }

    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      throw new TypeError("Select at least one capability to approve.");
    }

    const requested = new Set(manifest.permissions);
    const unique = [...new Set(capabilities)];
    for (const id of unique) {
      if (typeof id !== "string" || !requested.has(id)) {
        throw new Error(`Cannot approve ${String(id)}: the plugin did not request this capability.`);
      }
      const definition = CAPABILITIES[id as keyof typeof CAPABILITIES];
      if (!definition || definition.apiVersion > manifest.apiVersion) {
        throw new Error(`Cannot approve unsupported capability: ${id}.`);
      }
    }

    await this.store.grantPermissions(manifest.id, manifest.version, unique);
  }

  /** Revoke selected permissions, or all permissions for this exact release. */
  revoke(
    pluginId: string,
    pluginVersion: string,
    capabilities?: readonly string[],
  ): Promise<void> {
    return this.store.revokePermissions(pluginId, pluginVersion, capabilities);
  }

  /** Revoke every stored release approval for one plugin identity. */
  revokePlugin(pluginId: string): Promise<void> {
    return this.store.revokePlugin(pluginId);
  }
}
