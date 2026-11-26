import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginSettingsStore } from "../../src/plugins/plugin-settings-store.js";
import { FontStore } from "../../src/plugins/font-store.js";
import { AudioStore } from "../../src/plugins/audio-store.js";
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
  const fonts = new FontStore({ directory: join(directory, "fonts") });
  const audio = new AudioStore({ directory: join(directory, "audio") });
  const registry = new PluginSettingsPanelRegistry();
  registry.register("dev.example.plugin", definition);
  const service = {
    refresh: async () => ({
      plugins: [{ id: "dev.example.plugin", name: "Example", version: "1.0.0", state: "READY", trusted: true, enabled: true, runtimeState: "ACTIVE" }],
      rejected: [],
    }),
    setEnabled: async (_id: unknown, _version: unknown, _enabled: unknown) => ({
      plugins: [], rejected: [],
    }),
  };
  const dispose = installPluginSettingsPageIpc({ ipcMain: ipc, service: service as never, registry, store, fonts, audio });
  const mainFrame = { url: "https://yapper.website/settings" };
  const sender = { mainFrame, isDestroyed: () => false };
  const authorizedEvent = { sender, senderFrame: mainFrame };
  try {
    const snapshot = await ipc.handlers.get("yplusplus:settings-page:snapshot")!(authorizedEvent);
    assert.equal((snapshot as any).plugins[0].id, "dev.example.plugin");
    assert.equal((snapshot as any).plugins[0].enabled, true);
    assert.deepEqual((snapshot as any).fonts, []);
    assert.deepEqual((snapshot as any).audio, []);
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
      Promise.resolve(get({ sender, senderFrame: { url: "https://yapper.website/settings" } }, "dev.example.plugin", "general", "enabled")),
      /Unauthorized/,
    );

    const enable = ipc.handlers.get("yplusplus:settings-page:enabled")!;
    await enable(authorizedEvent, "dev.example.plugin", "1.0.0", false);
    const importFont = ipc.handlers.get("yplusplus:settings-page:font-import")!;
    const fakeTtf = new Uint8Array(12);
    new DataView(fakeTtf.buffer).setUint32(0, 0x00010000, false);
    const imported = await importFont(authorizedEvent, "Example.ttf", fakeTtf) as readonly { id: string }[];
    assert.equal(imported.length, 1);
    const selectFont = ipc.handlers.get("yplusplus:settings-page:font-select")!;
    await selectFont(authorizedEvent, imported[0]!.id);
    const activeFont = ipc.handlers.get("yplusplus:settings-page:font-active")!;
    assert.equal(await activeFont(authorizedEvent), null, "fonts are not exposed until the Fonts plugin is active");
    const removeFont = ipc.handlers.get("yplusplus:settings-page:font-remove")!;
    assert.deepEqual(await removeFont(authorizedEvent, imported[0]!.id), []);
  } finally {
    dispose();
    assert.equal(ipc.handlers.size, 0);
    assert.equal(ipc.removed.length, 12);
    await rm(directory, { recursive: true, force: true });
  }
});


test("active TTF is returned only while the trusted Fonts plugin is enabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yplusplus-font-ipc-"));
  const ipc = new FakeIpcMain();
  const store = new PluginSettingsStore({ directory: join(directory, "settings") });
  const fonts = new FontStore({ directory: join(directory, "fonts") });
  const audio = new AudioStore({ directory: join(directory, "audio") });
  const registry = new PluginSettingsPanelRegistry();
  let trusted = true;
  let enabled = true;
  const service = {
    refresh: async () => ({
      plugins: [{
        id: "dev.yplusplus.fonts",
        name: "Fonts",
        version: "1.0.0",
        state: "READY",
        trusted,
        enabled,
        runtimeState: "UNLOADED",
      }],
      rejected: [],
    }),
  };
  const dispose = installPluginSettingsPageIpc({
    ipcMain: ipc,
    service: service as never,
    registry,
    store,
    fonts,
    audio,
  });
  const mainFrame = { url: "https://yapper.website/settings" };
  const event = { sender: { mainFrame, isDestroyed: () => false }, senderFrame: mainFrame };
  try {
    const bytes = new Uint8Array(12);
    new DataView(bytes.buffer).setUint32(0, 0x00010000, false);
    const font = await fonts.importFont("Private.ttf", bytes);
    await fonts.setActive(font.id);

    const snapshot = await ipc.handlers.get("yplusplus:settings-page:snapshot")!(event) as {
      readonly panels: readonly { readonly pluginId: string; readonly panel: { readonly id: string } }[];
    };
    assert.ok(snapshot.panels.some((entry) =>
      entry.pluginId === "dev.yplusplus.fonts" && entry.panel.id === "fonts"),
    "the built-in Fonts settings panel remains available when its runtime is stopped");

    const get = ipc.handlers.get("yplusplus:settings-page:get")!;
    const set = ipc.handlers.get("yplusplus:settings-page:set")!;
    assert.equal(await get(event, "dev.yplusplus.fonts", "fonts", "apply"), true);
    await set(event, "dev.yplusplus.fonts", "fonts", "apply", false);

    const activeFont = ipc.handlers.get("yplusplus:settings-page:font-active")!;
    assert.equal(await activeFont(event), null, "the Apply selected font preference can be edited while Fonts is stopped");
    await set(event, "dev.yplusplus.fonts", "fonts", "apply", true);
    const active = await activeFont(event) as { readonly family: string; readonly bytes: Uint8Array } | null;
    assert.equal(active?.family, "YPlusPlusFont_" + font.id);
    assert.deepEqual(Array.from(active?.bytes ?? []), Array.from(bytes));

    enabled = false;
    assert.equal(await activeFont(event), null);
    enabled = true;
    trusted = false;
    assert.equal(await activeFont(event), null);
  } finally {
    dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
