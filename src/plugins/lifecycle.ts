/**
 * Pure plugin lifecycle transition policy.
 *
 * This module does not execute plugin code or perform lifecycle side effects.
 * The manager orchestrates those operations around this state machine.
 */
export const PLUGIN_STATES = [
  "DISCOVERED",
  "VALIDATING",
  "WAITING_FOR_APPROVAL",
  "READY",
  "INITIALIZING",
  "ACTIVE",
  "SUSPENDED",
  "FAILED",
  "UNLOADING",
  "UNLOADED",
] as const;

export type PluginState = (typeof PLUGIN_STATES)[number];

export interface InvalidTransition {
  readonly ok: false;
  readonly code: "INVALID_TRANSITION";
  readonly from: PluginState;
  readonly to: PluginState;
  readonly message: string;
}
export interface SuccessfulTransition {
  readonly ok: true;
  readonly from: PluginState;
  readonly to: PluginState;
  readonly changed: boolean;
}

const TRANSITIONS: Readonly<Record<PluginState, readonly PluginState[]>> = {
  DISCOVERED: ["VALIDATING", "FAILED", "UNLOADING"],
  VALIDATING: ["WAITING_FOR_APPROVAL", "READY", "FAILED", "UNLOADING"],
  WAITING_FOR_APPROVAL: ["READY", "FAILED", "UNLOADING"],
  READY: ["INITIALIZING", "FAILED", "UNLOADING"],
  INITIALIZING: ["ACTIVE", "FAILED", "UNLOADING"],
  ACTIVE: ["SUSPENDED", "FAILED", "UNLOADING"],
  SUSPENDED: ["ACTIVE", "FAILED", "UNLOADING"],
  FAILED: ["UNLOADING"],
  UNLOADING: ["UNLOADED"],
  UNLOADED: [],
};

export function canTransitionPluginState(from: PluginState, to: PluginState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** Apply one state transition without side effects. */
export function transitionPluginState(from: PluginState, to: PluginState): SuccessfulTransition | InvalidTransition {
  if (!canTransitionPluginState(from, to)) {
    return {
      ok: false,
      code: "INVALID_TRANSITION",
      from,
      to,
      message: `Plugin lifecycle cannot transition from ${from} to ${to}.`,
    };
  }
  return { ok: true, from, to, changed: from !== to };
}

export function isTerminalPluginState(state: PluginState): boolean {
  return state === "UNLOADED";
}

export function getAllowedPluginTransitions(state: PluginState): readonly PluginState[] {
  return TRANSITIONS[state];
}
