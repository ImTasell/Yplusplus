import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PluginEnabledStore } from "../../src/plugins/plugin-enabled-store.js";

test("plugin enable preferences default on and persist exact release overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "yplusplus-plugin-enabled-"));
  const store = new PluginEnabledStore({ filePath: join(root, "enabled.json") });
  try {
    assert.equal(await store.isEnabled("dev.example.plugin", "1.0.0"), true);
    await store.setEnabled("dev.example.plugin", "1.0.0", false);
    assert.equal(await store.isEnabled("dev.example.plugin", "1.0.0"), false);
    assert.equal(await store.isEnabled("dev.example.plugin", "1.1.0"), true);
    await store.setEnabled("dev.example.plugin", "1.0.0", true);
    assert.equal(await store.isEnabled("dev.example.plugin", "1.0.0"), true);
    const document = JSON.parse(await readFile(join(root, "enabled.json"), "utf8"));
    assert.deepEqual(document, { storeVersion: 1, disabled: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin enable store rejects malformed identities and invalid values", async () => {
  const root = await mkdtemp(join(tmpdir(), "yplusplus-plugin-enabled-invalid-"));
  const store = new PluginEnabledStore({ filePath: join(root, "enabled.json") });
  try {
    await assert.rejects(store.isEnabled("../escape", "1.0.0"), /plugin ID/);
    await assert.rejects(store.setEnabled("dev.example.plugin", "latest", false), /SemVer/);
    await assert.rejects((store.setEnabled as (id: string, version: string, value: unknown) => Promise<void>)("dev.example.plugin", "1.0.0", "false"), /boolean/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
