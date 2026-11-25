import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PluginSettingsStore } from "../../src/plugins/plugin-settings-store.js";

async function fixture(run: (store: PluginSettingsStore, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yplusplus-settings-"));
  try {
    await run(new PluginSettingsStore({ directory }), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("returns defaults and persists plugin-scoped values across store instances", async () => {
  await fixture(async (store, directory) => {
    assert.equal(await store.get("dev.example.alpha", "enabled", true), true);
    await store.set("dev.example.alpha", "enabled", false);
    const restarted = new PluginSettingsStore({ directory });
    assert.equal(await restarted.get("dev.example.alpha", "enabled", true), false);
    assert.equal(await restarted.get("dev.example.beta", "enabled", true), true);
  });
});

test("isolates plugin IDs and validates setting keys and values", async () => {
  await fixture(async (store) => {
    await store.set("dev.example.alpha", "theme", "dark");
    assert.equal(await store.get("dev.example.beta", "theme", "light"), "light");
    await assert.rejects(store.set("../escape", "x", true), /plugin ID/i);
    await assert.rejects(store.set("dev.example.alpha", "../escape", true), /setting keys/i);
    await assert.rejects(store.set("dev.example.alpha", "bad", Number.NaN), /finite numbers/i);
    await assert.rejects(store.set("dev.example.alpha", "bad", { nested: true } as never), /strings, finite numbers, or booleans/i);
  });
});

test("serializes concurrent writes without losing keys", async () => {
  await fixture(async (store) => {
    await Promise.all([
      store.set("dev.example.concurrent", "one", 1),
      store.set("dev.example.concurrent", "two", 2),
      store.set("dev.example.concurrent", "three", 3),
    ]);
    assert.deepEqual([
      await store.get("dev.example.concurrent", "one", 0),
      await store.get("dev.example.concurrent", "two", 0),
      await store.get("dev.example.concurrent", "three", 0),
    ], [1, 2, 3]);
  });
});

test("notifies only matching subscribers after persistence and supports disposal", async () => {
  await fixture(async (store, directory) => {
    const received: unknown[] = [];
    const dispose = store.subscribe("dev.example.events", "enabled", (value) => received.push(value));
    store.subscribe("dev.example.events", "other", (value) => received.push(`other:${value}`));
    await store.set("dev.example.events", "enabled", true);
    await store.set("dev.example.events", "enabled", true);
    dispose();
    await store.set("dev.example.events", "enabled", false);
    assert.deepEqual(received, [true]);
    const saved = JSON.parse(await readFile(path.join(directory, "dev.example.events.json"), "utf8"));
    assert.equal(saved.values.enabled, false);
  });
});

test("writes private settings files and rejects a malformed existing document", async () => {
  await fixture(async (store, directory) => {
    await store.set("dev.example.private", "value", "secret");
    assert.equal((await stat(path.join(directory, "dev.example.private.json"))).mode & 0o777, 0o600);
    await rm(path.join(directory, "dev.example.private.json"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(directory, "dev.example.private.json"), "{broken", { mode: 0o600 });
    await assert.rejects(store.set("dev.example.private", "other", true), /refusing to overwrite/i);
  });
});
