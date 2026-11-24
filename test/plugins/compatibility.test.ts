import assert from "node:assert/strict";
import test from "node:test";
import {
  checkPluginCompatibility,
  YPLUSPLUS_PLUGIN_API_VERSION,
} from "../../src/plugins/compatibility.js";

test("the host exposes an explicit plugin API generation", () => {
  assert.equal(YPLUSPLUS_PLUGIN_API_VERSION, 1);
});

test("accepts an exact API generation match", () => {
  const result = checkPluginCompatibility({ apiVersion: 1 });
  assert.deepEqual(result, {
    compatible: true,
    pluginApiVersion: 1,
    hostApiVersion: 1,
  });
  assert.ok(Object.isFrozen(result));
});

test("rejects a plugin targeting a newer API generation", () => {
  const result = checkPluginCompatibility({ apiVersion: 2 });
  assert.equal(result.compatible, false);
  if (result.compatible) assert.fail("Expected incompatibility.");
  assert.equal(result.failure.code, "unsupported-api-version");
  assert.equal(result.failure.expectedApiVersion, 1);
  assert.equal(result.failure.receivedApiVersion, 2);
});

test("rejects a plugin targeting an older API generation rather than assuming compatibility", () => {
  const result = checkPluginCompatibility({ apiVersion: 0 });
  assert.equal(result.compatible, false);
  if (result.compatible) assert.fail("Expected incompatibility.");
  assert.equal(result.failure.code, "unsupported-api-version");
});

test("supports explicit host API versions for deterministic policy tests", () => {
  assert.equal(checkPluginCompatibility({ apiVersion: 3 }, 3).compatible, true);
  const result = checkPluginCompatibility({ apiVersion: 2 }, 3);
  assert.equal(result.compatible, false);
});

test("rejects invalid host API versions", () => {
  for (const version of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => checkPluginCompatibility({ apiVersion: 1 }, version), RangeError);
  }
});
