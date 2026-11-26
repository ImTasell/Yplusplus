import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PluginEnabledStore } from "../../src/plugins/plugin-enabled-store.js";

test("plugin enable preferences default on and persist by stable plugin ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "yplusplus-plugin-enabled-"));
  const store = new PluginEnabledStore({ filePath: join(root, "enabled.json") });
  try {
    assert.equal(await store.isEnabled("dev.example.plugin"), true);
    await store.setEnabled("dev.example.plugin", false);
    assert.equal(await store.isEnabled("dev.example.plugin"), false);
    await store.setEnabled("dev.example.plugin", true);
    assert.equal(await store.isEnabled("dev.example.plugin"), true);
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
    await assert.rejects(store.isEnabled("../escape"), /plugin ID/);
    await assert.rejects(
      (store.setEnabled as (id: string, value: unknown) => Promise<void>)("dev.example.plugin", "false"),
      /boolean/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("plugin enable store migrates release-scoped disabled entries to stable plugin IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "yplusplus-plugin-enabled-migration-"));
  const filePath = join(root, "enabled.json");
  await writeFile(filePath, JSON.stringify({
    storeVersion: 1,
    disabled: [{ pluginId: "dev.example.plugin", pluginVersion: "1.0.0" }],
  }), { mode: 0o600 });
  await chmod(filePath, 0o600);
  const store = new PluginEnabledStore({ filePath });
  try {
    assert.equal(await store.isEnabled("dev.example.plugin"), false);
    await store.setEnabled("dev.example.plugin", true);
    const migrated = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(migrated, { storeVersion: 2, disabled: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
