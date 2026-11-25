/**
 * Narrow capability facade for Y++ plugins. Host adapters are injected.
 */
import type { ManagedPlugin, PluginApprovalProvider } from "../plugins/manager.js";
import type { PluginSettingsStore, PluginSettingValue } from "../plugins/plugin-settings-store.js";
import type { PluginSettingsPanelRegistry } from "../plugins/plugin-settings-panel-registry.js";
import type { SettingsPanelDefinition } from "../plugins/api.js";
export interface NotificationRequest { readonly title: string; readonly message: string; }
export type NotificationAdapter = (plugin: Readonly<{ id: string; version: string }>, request: NotificationRequest) => void | Promise<void>;
export interface CapabilityBrokerOptions {
  readonly getApprovedPermissions: PluginApprovalProvider;
  readonly notifications: NotificationAdapter;
  readonly settingsStore?: PluginSettingsStore;
  readonly settingsPanelRegistry?: PluginSettingsPanelRegistry;
}
export interface PluginCapabilityFacade {
  readonly notifications?: Readonly<{ show(request: NotificationRequest): Promise<void> }>;
  readonly ui?: Readonly<{ registerSettingsPanel(panel: SettingsPanelDefinition): () => void }>;
  readonly settings?: Readonly<{
    get(key: string, defaultValue: PluginSettingValue): Promise<PluginSettingValue>;
    set(key: string, value: PluginSettingValue): Promise<void>;
    subscribe(key: string, listener: (value: PluginSettingValue) => void): () => void;
  }>;
}
export class CapabilityDeniedError extends Error {
  readonly capability: string;
  constructor(capability: string, message: string) { super(message); this.name = "CapabilityDeniedError"; this.capability = capability; }
}
function normalizeNotification(input: unknown): NotificationRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("Notification request must be an object.");
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.some((key) => typeof key !== "string" || !["title", "message"].includes(key))) throw new TypeError("Notification request may contain only title and message.");
  const titleDescriptor = Object.getOwnPropertyDescriptor(input, "title");
  const messageDescriptor = Object.getOwnPropertyDescriptor(input, "message");
  if (!titleDescriptor || !("value" in titleDescriptor) || !messageDescriptor || !("value" in messageDescriptor)) throw new TypeError("Notification title and message must be own data properties.");
  const title: unknown = titleDescriptor.value, message: unknown = messageDescriptor.value;
  if (typeof title !== "string" || typeof message !== "string") throw new TypeError("Notification title and message must be strings.");
  const normalizedTitle = title.trim(), normalizedMessage = message.trim();
  if (normalizedTitle.length === 0 || normalizedTitle.length > 80) throw new RangeError("Notification title must contain 1–80 characters.");
  if (normalizedMessage.length === 0 || normalizedMessage.length > 500) throw new RangeError("Notification message must contain 1–500 characters.");
  return Object.freeze({ title: normalizedTitle, message: normalizedMessage });
}
export async function createPluginCapabilityFacade(plugin: ManagedPlugin, options: CapabilityBrokerOptions): Promise<PluginCapabilityFacade> {
  if (plugin.state !== "READY" || plugin.trusted !== true || !plugin.compatibility.compatible || plugin.compatibility.pluginApiVersion !== plugin.compatibility.hostApiVersion) {
    throw new CapabilityDeniedError("plugin.lifecycle", "Only explicitly trusted, compatible plugins in READY state can receive a capability facade.");
  }
  const requested = new Set(plugin.requestedPermissions);
  const approved = await options.getApprovedPermissions(plugin.id, plugin.version);
  const facade: { notifications?: NonNullable<PluginCapabilityFacade["notifications"]>; settings?: NonNullable<PluginCapabilityFacade["settings"]> } = {};
  if (requested.has("ui.notifications") && approved.has("ui.notifications")) {
    facade.notifications = Object.freeze({ show: async (input: NotificationRequest) => {
      const current = await options.getApprovedPermissions(plugin.id, plugin.version);
      if (!current.has("ui.notifications")) throw new CapabilityDeniedError("ui.notifications", "The host has not approved this capability or its approval was revoked.");
      await options.notifications(Object.freeze({ id: plugin.id, version: plugin.version }), normalizeNotification(input));
    } });
  }
  if (options.settingsPanelRegistry) {
    const pluginId = plugin.id;
    facade.ui = Object.freeze({ registerSettingsPanel: (panel: SettingsPanelDefinition) => options.settingsPanelRegistry!.register(pluginId, panel) });
  }
  if (options.settingsStore) {
    // The plugin ID is captured from the trusted manager snapshot, never RPC input.
    const pluginId = plugin.id;
    facade.settings = Object.freeze({
      get: (key: string, defaultValue: PluginSettingValue) => options.settingsStore!.get(pluginId, key, defaultValue),
      set: (key: string, value: PluginSettingValue) => options.settingsStore!.set(pluginId, key, value),
      subscribe: (key: string, listener: (value: PluginSettingValue) => void) => options.settingsStore!.subscribe(pluginId, key, listener),
    });
  }
  return Object.freeze(facade);
}
