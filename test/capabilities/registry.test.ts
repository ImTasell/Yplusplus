import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITIES,
  resolveCapabilityGrants,
} from "../../src/capabilities/registry.js";

test("catalog entries are descriptive metadata, not executable APIs", () => {
  assert.deepEqual(Object.keys(CAPABILITIES), ["ui.notifications"]);
  assert.equal(CAPABILITIES["ui.notifications"].apiVersion, 1);
  assert.equal(typeof CAPABILITIES["ui.notifications"].description, "string");
});

test("grants only requested, registered, explicitly approved capabilities", () => {
  const result = resolveCapabilityGrants(
    ["ui.notifications", "filesystem.read"],
    new Set(["ui.notifications", "filesystem.read"]),
    1,
  );

  assert.deepEqual(result.granted, ["ui.notifications"]);
  assert.deepEqual(result.denied, [
    { id: "filesystem.read", reason: "unsupported" },
  ]);
});

test("does not grant a supported capability without host approval", () => {
  const result = resolveCapabilityGrants(
    ["ui.notifications"],
    new Set(),
    1,
  );

  assert.deepEqual(result.granted, []);
  assert.deepEqual(result.denied, [
    { id: "ui.notifications", reason: "not-approved" },
  ]);
});

test("denies capabilities requiring a newer API generation", () => {
  const result = resolveCapabilityGrants(
    ["ui.notifications"],
    new Set(["ui.notifications"]),
    0,
  );

  assert.deepEqual(result.granted, []);
  assert.deepEqual(result.denied, [
    { id: "ui.notifications", reason: "unsupported" },
  ]);
});

test("returns immutable decisions and deduplicates requests", () => {
  const result = resolveCapabilityGrants(
    ["ui.notifications", "ui.notifications"],
    new Set(["ui.notifications"]),
    1,
  );

  assert.deepEqual(result.granted, ["ui.notifications"]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.granted));
});
