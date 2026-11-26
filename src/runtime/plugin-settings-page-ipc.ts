import { createHash } from "node:crypto";
import type { FontStore } from "../plugins/font-store.js";
import type { PluginSettingsStore } from "../plugins/plugin-settings-store.js";
import type { PluginSettingsPanelRegistry, RegisteredSettingsPanel } from "../plugins/plugin-settings-panel-registry.js";
import type { PluginManagerService } from "./plugin-manager-service.js";

interface SettingsPageFrame {
  readonly url?: string;
}
interface SettingsPageWebContents {
  readonly mainFrame: unknown;
  isDestroyed(): boolean;
}
interface SettingsPageEvent {
  readonly sender: SettingsPageWebContents;
  readonly senderFrame?: SettingsPageFrame | null;
}
interface SettingsPageIpcMain {
  handle(channel: string, listener: (event: SettingsPageEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

const CHANNELS = [
  "yplusplus:settings-page:snapshot",
  "yplusplus:settings-page:get",
  "yplusplus:settings-page:set",
  "yplusplus:settings-page:enabled",
  "yplusplus:settings-page:font-import",
  "yplusplus:settings-page:font-remove",
  "yplusplus:settings-page:font-select",
  "yplusplus:settings-page:font-active",
] as const;
const ALLOWED_HOSTS = new Set(["www.yapper.website", "yapper.website", "www.yapin.gg", "yapin.gg"]);
const FONTS_PLUGIN_ID = "dev.yplusplus.fonts";

function isAllowedFrame(event: SettingsPageEvent): boolean {
  if (event.sender.isDestroyed() || !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame || typeof event.senderFrame.url !== "string") return false;
  try {
    const url = new URL(event.senderFrame.url);
    return url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function settingKey(panelId: string, itemId: string): string {
  const digest = createHash("sha256").update(panelId).update("\0").update(itemId).digest("hex");
  return "ui." + digest;
}

function findItem(registry: PluginSettingsPanelRegistry, pluginId: string, panelId: string, itemId: string) {
  const registered = registry.list().find((entry) =>
    entry.pluginId === pluginId && entry.panel.id === panelId);
  const item = registered?.panel.items.find((candidate) => candidate.id === itemId);
  if (!registered || !item) throw new Error("This plugin setting is no longer available.");
  return { registered, item };
}

function validateValue(item: RegisteredSettingsPanel["panel"]["items"][number], value: unknown): void {
  if (item.type === "toggle" && typeof value === "boolean") return;
  if (item.type === "text" && typeof value === "string" && value.length <= (item.maxLength ?? 8192)) return;
  if (item.type === "number" && typeof value === "number" && Number.isFinite(value) &&
      (item.min === undefined || value >= item.min) &&
      (item.max === undefined || value <= item.max)) return;
  if (item.type === "select" && typeof value === "string" &&
      item.options.some((option) => option.value === value)) return;
  throw new TypeError("The value does not match this plugin setting.");
}

function isFontBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

export interface PluginSettingsPageIpcOptions {
  readonly ipcMain: SettingsPageIpcMain;
  readonly service: PluginManagerService;
  readonly registry: PluginSettingsPanelRegistry;
  readonly store: PluginSettingsStore;
  readonly fonts: FontStore;
}

/** Installs a constrained plugin/settings/font bridge for the authenticated Yapper main frame. */
export function installPluginSettingsPageIpc(options: PluginSettingsPageIpcOptions): () => void {
  const handlers: readonly [string, (event: SettingsPageEvent, ...args: unknown[]) => unknown][] = [
    [CHANNELS[0], async (event) => {
      if (!isAllowedFrame(event)) throw new Error("Unauthorized Y++ settings request.");
      const [snapshot, panels, fonts] = await Promise.all([
        options.service.refresh(),
        Promise.resolve(options.registry.list()),
        options.fonts.list(),
      ]);
      return Object.freeze({
        plugins: snapshot.plugins.map(({ id, name, version, state, trusted, enabled, runtimeState }) =>
          Object.freeze({ id, name, version, state, trusted, enabled, runtimeState })),
        panels: panels.map(({ pluginId, panel }) => Object.freeze({ pluginId, panel })),
        fonts,
      });
    }],
    [CHANNELS[1], async (event, pluginId, panelId, itemId) => {
      if (!isAllowedFrame(event)) throw new Error("Unauthorized Y++ settings request.");
      if (typeof pluginId !== "string" || typeof panelId !== "string" || typeof itemId !== "string") {
        throw new TypeError("Invalid plugin setting identity.");
      }
      const { item } = findItem(options.registry, pluginId, panelId, itemId);
      return options.store.get(pluginId, settingKey(panelId, itemId), item.defaultValue);
    }],
    [CHANNELS[2], async (event, pluginId, panelId, itemId, value) => {
      if (!isAllowedFrame(event)) throw new Error("Unauthorized Y++ settings request.");
      if (typeof pluginId !== "string" || typeof panelId !== "string" || typeof itemId !== "string") {
        throw new TypeError("Invalid plugin setting identity.");
      }
      const { item } = findItem(options.registry, pluginId, panelId, itemId);
      validateValue(item, value);
      await options.store.set(pluginId, settingKey(panelId, itemId), value as string | number | boolean);
      return null;
    }],
    [CHANNELS[3], async (event, pluginId, version, enabled) => {
      if (!isAllowedFrame(event)) throw new Error("Unauthorized Y++ settings request.");
      return options.service.setEnabled(pluginId, version, enabled);
    }],
    [CHANNELS[4], async (event, fileName, bytes) => {
      if (!isAllowedFrame(event)) throw new Error("Unauthorized Y++ font import request.");
      if (!isFontBytes(bytes)) throw new TypeError("Font upload must contain binary data.");
      await options.fonts.importFont(fileName, bytes);
      return options.fonts.list();
    }],
    [CHANNELS[5], async (event, fontId) => {
      if (!isAllowedFrame(event)) throw new Error("Unauthorized Y++ font request.");
      await options.fonts.remove(fontId);
      return options.fonts.list();
    }],
    [CHANNELS[6], async (event, fontId) => {
      if (!isAllowedFrame(event)) throw new Error("Unauthorized Y++ font request.");
      await options.fonts.setActive(fontId);
      return options.fonts.list();
    }],
    [CHANNELS[7], async (event) => {
      if (!isAllowedFrame(event)) throw new Error("Unauthorized Y++ font request.");
      const snapshot = await options.service.refresh();
      const fontsPlugin = snapshot.plugins.find((plugin) => plugin.id === FONTS_PLUGIN_ID);
      if (!fontsPlugin || !fontsPlugin.trusted || !fontsPlugin.enabled) return null;
      const apply = await options.store.get(FONTS_PLUGIN_ID, settingKey("fonts", "apply"), true);
      if (!apply) return null;
      return options.fonts.getActive();
    }],
  ];
  for (const [channel, handler] of handlers) options.ipcMain.handle(channel, handler);
  return () => { for (const channel of CHANNELS) options.ipcMain.removeHandler(channel); };
}
