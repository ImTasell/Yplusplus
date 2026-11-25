import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginSettingsStore } from "../../src/plugins/plugin-settings-store.js";
import { PluginSettingsPanelRegistry } from "../../src/plugins/plugin-settings-panel-registry.js";
import { installPluginSettingsPageIpc } from "../../src/runtime/plugin-settings-page-ipc.js";

class FakeIpcMain {
  readonly handlers = new Map<string, (event: any, ...args: unknown[]) => unknown>();
  readonly removed: string[] = [];
  handle(channel: string, listener: (event: any, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
    this.removed.push(channel);
  }
}

const definition = {
  id: "general",
  title: "General",
  items: [
    { type: "toggle", id: "enabled", label: "Enabled", defaultValue: true },
    { type: "number", id: "scale", label: "Scale", defaultValue: 1, min: 0, max: 2 },
  ],
};

test("native settings IPC exposes only registered plugin settings and validates writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yplusplus-settings-page-"));
  const ipc = new FakeIpcMain();
  const store = new PluginSettingsStore({ directory });
  const registry = new PluginSettingsPanelRegistry();
  registry.register("dev.example.plugin", definition);
  const service = { refresh: async () => ({
    plugins: [{ id: "dev.example.plugin", name: "Example", version: "1.0.0", state: "READY", runtimeState: "ACTIVE" }],
    rejected: [],
  }) };
  const dispose = installPluginSettingsPageIpc({ ipcMain: ipc, service: service as never, registry, store });
  const sender = { mainFrame: {}, isDestroyed: () => false };
  const event = { sender, senderFrame: { get url() { return "https://yapper.website/settings"; } } };
  const authorizedEvent = { sender, senderFrame: sender.mainFrame };
  try {
    const snapshot = await ipc.handlers.get("yplusplus:settings-page:snapshot")!(authorizedEvent);
    assert.equal((snapshot as any).plugins[0].id, "dev.example.plugin");
    assert.equal((snapshot as any).panels[0].panel.id, "general");

    const get = ipc.handlers.get("yplusplus:settings-page:get")!;
    const set = ipc.handlers.get("yplusplus:settings-page:set")!;
    assert.equal(await get(authorizedEvent, "dev.example.plugin", "general", "enabled"), true);
    await set(authorizedEvent, "dev.example.plugin", "general", "enabled", false);
    assert.equal(await get(authorizedEvent, "dev.example.plugin", "general", "enabled"), false);
    await assert.rejects(
      Promise.resolve(set(authorizedEvent, "dev.example.plugin", "general", "scale", 3)),
      /does not match/,
    );
    await assert.rejects(
      Promise.resolve(get(authorizedEvent, "dev.example.other", "general", "enabled")),
      /no longer available/,
    );
    await assert.rejects(
      Promise.resolve(get({ sender, senderFrame: event.senderFrame }, "dev.example.plugin", "general", "enabled")),
      /Unauthorized/,
    );
  } finally {
    dispose();
    assert.equal(ipc.handlers.size, 0);
    assert.equal(ipc.removed.length, 3);
    await rm(directory, { recursive: true, force: true });
  }
});
