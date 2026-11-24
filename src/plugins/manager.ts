/**
 * Plugin manager inspection/orchestration layer.
 *
 * Connects discovery, API compatibility, host approval decisions, capability
 * policy, and lifecycle state. It deliberately stops at READY: plugin entry
 * points are never imported or executed here.
 */
import { resolveCapabilityGrants } from "../capabilities/registry.js";
import type { DiscoveredPlugin, PluginDiscoveryReport } from "./discovery.js";
import { checkPluginCompatibility, YPLUSPLUS_PLUGIN_API_VERSION } from "./compatibility.js";
import { transitionPluginState, type PluginState } from "./lifecycle.js";

export type PluginApprovalProvider = (
  pluginId: string,
  pluginVersion: string,
) => Promise<ReadonlySet<string>>;

export interface ManagedPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly directory: string;
  readonly state: PluginState;
  readonly requestedPermissions: readonly string[];
  readonly approvedPermissions: readonly string[];
  readonly deniedPermissions: readonly { readonly id: string; readonly reason: "unsupported" | "not-approved" }[];
  readonly compatibility: ReturnType<typeof checkPluginCompatibility>;
  readonly issue?: {
    readonly code: "unsupported-api-version" | "approval-provider-failed";
    readonly message: string;
  };
}

export interface PluginManagerReport {
  readonly plugins: readonly ManagedPlugin[];
  readonly rejected: PluginDiscoveryReport["rejected"];
  readonly counts: Readonly<{
    ready: number;
    waitingForApproval: number;
    incompatible: number;
    approvalFailures: number;
    rejectedDuringDiscovery: number;
  }>;
}

export interface PluginManagerOptions {
  readonly hostApiVersion?: number;
  /** Must return trusted host approval state, never plugin-supplied data. */
  readonly getApprovedPermissions: PluginApprovalProvider;
}

function advance(from: PluginState, to: PluginState): PluginState {
  const result = transitionPluginState(from, to);
  if (!result.ok) throw new Error(result.message);
  return result.to;
}

async function inspectDiscoveredPlugin(
  plugin: DiscoveredPlugin,
  options: PluginManagerOptions,
): Promise<ManagedPlugin> {
  let state = advance("DISCOVERED", "VALIDATING");
  const compatibility = checkPluginCompatibility(
    plugin.manifest,
    options.hostApiVersion ?? YPLUSPLUS_PLUGIN_API_VERSION,
  );

  if (!compatibility.compatible) {
    state = advance(state, "FAILED");
    return Object.freeze({
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      directory: plugin.directory,
      state,
      requestedPermissions: plugin.manifest.permissions,
      approvedPermissions: Object.freeze([]),
      deniedPermissions: Object.freeze(plugin.manifest.permissions.map((id) => Object.freeze({
        id, reason: "unsupported" as const,
      }))),
      compatibility,
      issue: Object.freeze({
        code: "unsupported-api-version" as const,
        message: compatibility.failure.message,
      }),
    });
  }

  const approved = await options.getApprovedPermissions(
    plugin.manifest.id,
    plugin.manifest.version,
  );
  const grants = resolveCapabilityGrants(
    plugin.manifest.permissions,
    approved,
    plugin.manifest.apiVersion,
  );
  const hasPendingApproval = grants.denied.some((item) => item.reason === "not-approved");
  state = hasPendingApproval
    ? advance(state, "WAITING_FOR_APPROVAL")
    : advance(state, "READY");

  return Object.freeze({
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    directory: plugin.directory,
    state,
    requestedPermissions: plugin.manifest.permissions,
    approvedPermissions: grants.granted,
    deniedPermissions: grants.denied,
    compatibility,
  });
}

/** Inspect plugins independently and return an immutable, non-executable snapshot. */
export async function inspectPlugins(
  discovery: PluginDiscoveryReport,
  options: PluginManagerOptions,
): Promise<PluginManagerReport> {
  const plugins: ManagedPlugin[] = [];
  for (const plugin of discovery.plugins) {
    try {
      plugins.push(await inspectDiscoveredPlugin(plugin, options));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Approval lookup failed.";
      const compatibility = checkPluginCompatibility(
        plugin.manifest,
        options.hostApiVersion ?? YPLUSPLUS_PLUGIN_API_VERSION,
      );
      plugins.push(Object.freeze({
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        directory: plugin.directory,
        state: "FAILED" as const,
        requestedPermissions: plugin.manifest.permissions,
        approvedPermissions: Object.freeze([]),
        deniedPermissions: Object.freeze(plugin.manifest.permissions.map((id) => Object.freeze({
          id, reason: "not-approved" as const,
        }))),
        compatibility,
        issue: Object.freeze({
          code: "approval-provider-failed" as const,
          message: `Approval lookup failed: ${message}`,
        }),
      }));
    }
  }

  const ready = plugins.filter((plugin) => plugin.state === "READY").length;
  const waitingForApproval = plugins.filter((plugin) => plugin.state === "WAITING_FOR_APPROVAL").length;
  const incompatible = plugins.filter((plugin) => !plugin.compatibility.compatible).length;
  const approvalFailures = plugins.filter((plugin) => plugin.issue?.code === "approval-provider-failed").length;

  return Object.freeze({
    plugins: Object.freeze(plugins),
    rejected: discovery.rejected,
    counts: Object.freeze({
      ready,
      waitingForApproval,
      incompatible,
      approvalFailures,
      rejectedDuringDiscovery: discovery.rejected.length,
    }),
  });
}
