/**
 * Capability catalog and grant decision policy.
 *
 * This is policy metadata only. It does not expose or execute any capability.
 * The approval input must come from trusted host state, never plugin input.
 */

export interface CapabilityDefinition {
  readonly id: string;
  readonly description: string;
  readonly risk: "low" | "medium" | "high";
  readonly apiVersion: number;
}

export const CAPABILITIES = Object.freeze({
  "ui.notifications": Object.freeze({
    id: "ui.notifications",
    description: "Request user-visible notifications through the Y++ host.",
    risk: "low",
    apiVersion: 1,
  }),
} satisfies Record<string, CapabilityDefinition>);

export type CapabilityDenialReason = "unsupported" | "not-approved";

export interface CapabilityDenial {
  readonly id: string;
  readonly reason: CapabilityDenialReason;
}

export interface CapabilityGrantDecision {
  readonly granted: readonly string[];
  readonly denied: readonly CapabilityDenial[];
}

/**
 * Resolve requested capabilities against the host catalog and a trusted
 * approval list. A capability is granted only when both checks pass.
 */
export function resolveCapabilityGrants(
  requested: readonly string[],
  approvedByHost: ReadonlySet<string>,
  apiVersion: number,
): CapabilityGrantDecision {
  const granted: string[] = [];
  const denied: CapabilityDenial[] = [];

  for (const id of new Set(requested)) {
    const definition = CAPABILITIES[id as keyof typeof CAPABILITIES];

    if (!definition || definition.apiVersion > apiVersion) {
      denied.push({ id, reason: "unsupported" });
    } else if (!approvedByHost.has(id)) {
      denied.push({ id, reason: "not-approved" });
    } else {
      granted.push(id);
    }
  }

  return Object.freeze({
    granted: Object.freeze(granted),
    denied: Object.freeze(denied.map((item) => Object.freeze(item))),
  });
}
