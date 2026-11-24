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

test("declares the complete lifecycle state set including READY", () => {
  assert.deepEqual(PLUGIN_STATES, [
    "DISCOVERED", "VALIDATING", "WAITING_FOR_TRUST", "WAITING_FOR_APPROVAL", "READY",
    "INITIALIZING", "ACTIVE", "SUSPENDED", "FAILED", "UNLOADING", "UNLOADED",
  ]);
});

test("allows successful activation with and without an approval wait", () => {
  const paths: PluginState[][] = [
    ["DISCOVERED", "VALIDATING", "WAITING_FOR_TRUST", "WAITING_FOR_APPROVAL", "READY", "INITIALIZING", "ACTIVE"],
    ["DISCOVERED", "VALIDATING", "READY", "INITIALIZING", "ACTIVE"],
  ];
  for (const path of paths) {
    for (let i = 0; i < path.length - 1; i += 1) {
      assert.equal(canTransitionPluginState(path[i]!, path[i + 1]!), true);
    }
  }
  assert.equal(canTransitionPluginState("ACTIVE", "SUSPENDED"), true);
  assert.equal(canTransitionPluginState("SUSPENDED", "ACTIVE"), true);
});

test("allows failure from pre-active and active states", () => {
  for (const state of [
    "DISCOVERED", "VALIDATING", "WAITING_FOR_TRUST", "WAITING_FOR_APPROVAL", "READY",
    "INITIALIZING", "ACTIVE", "SUSPENDED",
  ] as const) assert.equal(canTransitionPluginState(state, "FAILED"), true);
  assert.equal(canTransitionPluginState("FAILED", "UNLOADING"), true);
});

test("rejects invalid transitions with structured endpoints", () => {
  assert.deepEqual(transitionPluginState("DISCOVERED", "ACTIVE"), {
    ok: false, code: "INVALID_TRANSITION", from: "DISCOVERED", to: "ACTIVE",
    message: "Plugin lifecycle cannot transition from DISCOVERED to ACTIVE.",
  });
});

test("same-state transitions are idempotent", () => {
  for (const state of PLUGIN_STATES) {
    assert.deepEqual(transitionPluginState(state, state), {
      ok: true, from: state, to: state, changed: false,
    });
  }
});

test("UNLOADED is terminal and cleanup follows UNLOADING", () => {
  assert.equal(isTerminalPluginState("UNLOADED"), true);
  assert.deepEqual(getAllowedPluginTransitions("FAILED"), ["UNLOADING"]);
  assert.deepEqual(getAllowedPluginTransitions("UNLOADING"), ["UNLOADED"]);
  for (const state of PLUGIN_STATES) {
    assert.equal(canTransitionPluginState("UNLOADED", state), state === "UNLOADED");
  }
});
