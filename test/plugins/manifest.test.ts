import assert from "node:assert/strict";
import test from "node:test";
import {
  PLUGIN_MANIFEST_FILE,
  validatePluginManifest,
  type PluginManifestV1,
} from "../../src/plugins/manifest.js";

const validManifest: PluginManifestV1 = {
  manifestVersion: 1,
  id: "dev.example.hello",
  name: "Hello Y++",
  version: "1.2.3",
  description: "A sample plugin for manifest validation.",
  apiVersion: 1,
  entry: "dist/index.js",
  permissions: ["ui.notifications"],
};

test("manifest filename is stable", () => {
  assert.equal(PLUGIN_MANIFEST_FILE, "yplusplus.plugin.json");
});

test("accepts a valid manifest and returns an immutable copy", () => {
  const result = validatePluginManifest(validManifest);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.manifest, validManifest);
  assert.notEqual(result.manifest, validManifest);
  assert.ok(Object.isFrozen(result.manifest));
  assert.ok(Object.isFrozen(result.manifest.permissions));
});

test("accepts an empty permission list and SemVer prerelease metadata", () => {
  const result = validatePluginManifest({
    ...validManifest,
    version: "2.0.0-rc.1+build.42",
    permissions: [],
  });
  assert.equal(result.ok, true);
});

test("rejects non-object input", () => {
  for (const value of [null, [], "plugin", 42]) {
    const result = validatePluginManifest(value);
    assert.equal(result.ok, false);
  }
});

test("rejects unsupported manifest versions and unknown fields", () => {
  const result = validatePluginManifest({
    ...validManifest,
    manifestVersion: 2,
    surprise: true,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.code === "unsupported-version"));
  assert.ok(result.issues.some((issue) => issue.code === "unknown-field"));
});

test("rejects malformed IDs, versions, and API generations", () => {
  const result = validatePluginManifest({
    ...validManifest,
    id: "Dev/Example",
    version: "not-semver",
    apiVersion: 0,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.path === "id"));
  assert.ok(result.issues.some((issue) => issue.path === "version"));
  assert.ok(result.issues.some((issue) => issue.path === "apiVersion"));
});

test("rejects absolute, traversal, and platform-specific entry paths", () => {
  for (const entry of [
    "../outside.js",
    "dist/../../outside.js",
    "/tmp/plugin.js",
    "C:/plugin.js",
    "dist\\plugin.js",
    "dist//plugin.js",
    "./index.js",
  ]) {
    const result = validatePluginManifest({ ...validManifest, entry });
    assert.equal(result.ok, false, `expected ${entry} to be rejected`);
  }
});

test("rejects duplicate and malformed capability identifiers", () => {
  const result = validatePluginManifest({
    ...validManifest,
    permissions: ["ui.notifications", "ui.notifications", "Node.fs", "bad capability"],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.code === "duplicate"));
  assert.ok(result.issues.some((issue) => issue.code === "format"));
});

test("does not mutate the supplied manifest", () => {
  const source = {
    ...validManifest,
    permissions: ["ui.notifications"],
  };
  const before = structuredClone(source);
  validatePluginManifest(source);
  assert.deepEqual(source, before);
});
