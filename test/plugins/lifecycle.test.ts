import assert from "node:assert/strict";
import test from "node:test";
import {
  PLUGIN_STATES,
  canTransitionPluginState,
  getAllowedPluginTransitions,
  isTerminalPluginState,
  transitionPluginState,
  type PluginState,
} from "../../src/plugins/lifecycle.js";

test("declares the complete lifecycle state set", () => {
  assert.deepEqual(PLUGIN_STATES, [
    "DISCOVERED",
    "VALIDATING",
    "WAITING_FOR_APPROVAL",
    "INITIALIZING",
    "ACTIVE",
    "SUSPENDED",
    "FAILED",
    "UNLOADING",
    "UNLOADED",
  ]);
});

test("allows the intended successful activation path", () => {
  const path: PluginState[] = [
    "DISCOVERED",
    "VALIDATING",
    "WAITING_FOR_APPROVAL",
    "INITIALIZING",
    "ACTIVE",
    "SUSPENDED",
    "ACTIVE",
    "UNLOADING",
    "UNLOADED",
  ];

  for (let index = 0; index < path.length - 1; index += 1) {
    assert.equal(
      canTransitionPluginState(path[index]!, path[index + 1]!),
      true,
      `expected ${path[index]} -> ${path[index + 1]} to be allowed`,
    );
  }
});

test("allows initialization without an approval wait when no approval is needed", () => {
  assert.equal(canTransitionPluginState("VALIDATING", "INITIALIZING"), true);
});

test("allows failure from operational states and cleanup after failure", () => {
  for (const state of [
    "DISCOVERED",
    "VALIDATING",
    "WAITING_FOR_APPROVAL",
    "INITIALIZING",
    "ACTIVE",
    "SUSPENDED",
  ] as const) {
    assert.equal(canTransitionPluginState(state, "FAILED"), true);
  }
  assert.equal(canTransitionPluginState("FAILED", "UNLOADING"), true);
});

test("rejects invalid transitions and reports their endpoints", () => {
  const result = transitionPluginState("DISCOVERED", "ACTIVE");
  assert.deepEqual(result, {
    ok: false,
    code: "INVALID_TRANSITION",
    from: "DISCOVERED",
    to: "ACTIVE",
    message: "Plugin lifecycle cannot transition from DISCOVERED to ACTIVE.",
  });
});

test("same-state transitions are idempotent no-ops", () => {
  for (const state of PLUGIN_STATES) {
    assert.deepEqual(transitionPluginState(state, state), {
      ok: true,
      from: state,
      to: state,
      changed: false,
    });
  }
});

test("unloaded is terminal", () => {
  assert.equal(isTerminalPluginState("UNLOADED"), true);
  assert.deepEqual(getAllowedPluginTransitions("UNLOADED"), []);
  for (const state of PLUGIN_STATES) {
    assert.equal(canTransitionPluginState("UNLOADED", state), state === "UNLOADED");
  }
});

test("unloading is the only exit from failed and always ends unloaded", () => {
  assert.deepEqual(getAllowedPluginTransitions("FAILED"), ["UNLOADING"]);
  assert.deepEqual(getAllowedPluginTransitions("UNLOADING"), ["UNLOADED"]);
});
