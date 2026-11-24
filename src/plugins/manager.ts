/**
 * Plugin manager inspection/orchestration layer.
 *
 * Trust and capability grants are separate host decisions. Inspection never
 * imports or executes plugin entry points.
 */
import { resolveCapabilityGrants } from "../capabilities/registry.js";
import type { DiscoveredPlugin, PluginDiscoveryReport } from "./discovery.js";
import { checkPluginCompatibility, YPLUSPLUS_PLUGIN_API_VERSION } from "./compatibility.js";
import { transitionPluginState, type PluginState } from "./lifecycle.js";

export type PluginApprovalProvider = (pluginId: string, pluginVersion: string) => Promise<ReadonlySet<string>>;
export type PluginTrustProvider = (pluginId: string, pluginVersion: string) => Promise<boolean>;

export interface ManagedPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly directory: string;
  readonly entry?: string;
  readonly state: PluginState;
  readonly trusted: boolean;
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
    waitingForTrust: number;
    waitingForApproval: number;
    incompatible: number;
    approvalFailures: number;
    rejectedDuringDiscovery: number;
  }>;
}

export interface PluginManagerOptions {
  readonly hostApiVersion?: number;
  /** Must read explicit host-owned trust decisions. Missing trust means false. */
  readonly isTrusted: PluginTrustProvider;
  /** Must return host-owned capability grants, never plugin-supplied data. */
  readonly getApprovedPermissions: PluginApprovalProvider;
}

function advance(from: PluginState, to: PluginState): PluginState {
  const result = transitionPluginState(from, to);
  if (!result.ok) throw new Error(result.message);
  return result.to;
}

async function inspectDiscoveredPlugin(plugin: DiscoveredPlugin, options: PluginManagerOptions): Promise<ManagedPlugin> {
  let state = advance("DISCOVERED", "VALIDATING");
  const compatibility = checkPluginCompatibility(plugin.manifest, options.hostApiVersion ?? YPLUSPLUS_PLUGIN_API_VERSION);
  const base = {
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    directory: plugin.directory,
    entry: plugin.manifest.entry,
    requestedPermissions: plugin.manifest.permissions,
    compatibility,
  };

  if (!compatibility.compatible) {
    state = advance(state, "FAILED");
    return Object.freeze({
      ...base, state, trusted: false,
      approvedPermissions: Object.freeze([]),
      deniedPermissions: Object.freeze(plugin.manifest.permissions.map((id) => Object.freeze({ id, reason: "unsupported" as const }))),
      issue: Object.freeze({ code: "unsupported-api-version" as const, message: compatibility.failure.message }),
    });
  }

  state = advance(state, "WAITING_FOR_TRUST");
  const trusted = await options.isTrusted(plugin.manifest.id, plugin.manifest.version);
  if (!trusted) {
    return Object.freeze({
      ...base, state, trusted: false,
      approvedPermissions: Object.freeze([]),
      deniedPermissions: Object.freeze([]),
    });
  }

  const approved = await options.getApprovedPermissions(plugin.manifest.id, plugin.manifest.version);
  const grants = resolveCapabilityGrants(plugin.manifest.permissions, approved, plugin.manifest.apiVersion);
  const hasPendingApproval = grants.denied.some((item) => item.reason === "not-approved");
  state = hasPendingApproval ? advance(state, "WAITING_FOR_APPROVAL") : advance(state, "READY");

  return Object.freeze({
    ...base, state, trusted: true,
    approvedPermissions: grants.granted,
    deniedPermissions: grants.denied,
  });
}

/** Inspect plugins independently and return an immutable, non-executable snapshot. */
export async function inspectPlugins(discovery: PluginDiscoveryReport, options: PluginManagerOptions): Promise<PluginManagerReport> {
  const hostApiVersion = options.hostApiVersion ?? YPLUSPLUS_PLUGIN_API_VERSION;
  if (!Number.isSafeInteger(hostApiVersion) || hostApiVersion < 1) throw new RangeError("Host API version must be a positive safe integer.");

  const plugins: ManagedPlugin[] = [];
  for (const plugin of discovery.plugins) {
    try {
      plugins.push(await inspectDiscoveredPlugin(plugin, options));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Host trust/approval lookup failed.";
      const compatibility = checkPluginCompatibility(plugin.manifest, hostApiVersion);
      plugins.push(Object.freeze({
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        directory: plugin.directory,
        entry: plugin.manifest.entry,
        state: "FAILED" as const,
        trusted: false,
        requestedPermissions: plugin.manifest.permissions,
        approvedPermissions: Object.freeze([]),
        deniedPermissions: Object.freeze(plugin.manifest.permissions.map((id) => Object.freeze({ id, reason: "not-approved" as const }))),
        compatibility,
        issue: Object.freeze({ code: "approval-provider-failed" as const, message: `Host trust/approval lookup failed: ${message}` }),
      }));
    }
  }

  const count = (state: PluginState) => plugins.filter((plugin) => plugin.state === state).length;
  return Object.freeze({
    plugins: Object.freeze(plugins),
    rejected: discovery.rejected,
    counts: Object.freeze({
      ready: count("READY"),
      waitingForTrust: count("WAITING_FOR_TRUST"),
      waitingForApproval: count("WAITING_FOR_APPROVAL"),
      incompatible: plugins.filter((plugin) => !plugin.compatibility.compatible).length,
      approvalFailures: plugins.filter((plugin) => plugin.issue?.code === "approval-provider-failed").length,
      rejectedDuringDiscovery: discovery.rejected.length,
    }),
  });
}
