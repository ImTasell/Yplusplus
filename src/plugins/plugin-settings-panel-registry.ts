/**
 * Host-owned registry for declarative plugin settings panels.
 * Definitions are copied, bounded, and never interpreted as executable markup.
 */
import type { SettingsPanelDefinition, SettingsPanelItem } from "./api.js";

export interface RegisteredSettingsPanel {
  readonly pluginId: string;
  readonly panel: SettingsPanelDefinition;
}
const ICONS = new Set(["settings", "sliders", "palette", "bell", "zap", "info", "code", "plug"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function text(value: unknown, label: string, max: number, optional = false): string | undefined {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new TypeError(`${label} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new TypeError(`Invalid ${label}.`);
  return value;
}
function validateItem(input: unknown): SettingsPanelItem {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("Settings panel items must be objects.");
  const item = input as Record<string, unknown>;
  const type = item.type;
  const id = identifier(item.id, "setting item ID");
  const label = text(item.label, "Setting label", 80)!;
  const description = text(item.description, "Setting description", 240, true);
  const common = { id, label, ...(description === undefined ? {} : { description }) };
  if (type === "toggle") {
    if (typeof item.defaultValue !== "boolean") throw new TypeError("Toggle defaults must be boolean.");
    return Object.freeze({ type, ...common, defaultValue: item.defaultValue });
  }
  if (type === "text") {
    if (typeof item.defaultValue !== "string" || item.defaultValue.length > 8192) throw new TypeError("Text defaults must be strings of at most 8192 characters.");
    const maxLength = item.maxLength === undefined ? 8192 : item.maxLength;
    if (!Number.isSafeInteger(maxLength) || (maxLength as number) < 1 || (maxLength as number) > 8192 || item.defaultValue.length > (maxLength as number)) throw new TypeError("Invalid text setting maxLength.");
    const placeholder = text(item.placeholder, "Text placeholder", 120, true);
    return Object.freeze({ type, ...common, defaultValue: item.defaultValue, maxLength: maxLength as number, ...(placeholder === undefined ? {} : { placeholder }) });
  }
  if (type === "number") {
    if (typeof item.defaultValue !== "number" || !Number.isFinite(item.defaultValue)) throw new TypeError("Number defaults must be finite.");
    const min = item.min, max = item.max, step = item.step;
    if (min !== undefined && (typeof min !== "number" || !Number.isFinite(min))) throw new TypeError("Number min must be finite.");
    if (max !== undefined && (typeof max !== "number" || !Number.isFinite(max))) throw new TypeError("Number max must be finite.");
    if (step !== undefined && (typeof step !== "number" || !Number.isFinite(step) || step <= 0)) throw new TypeError("Number step must be positive and finite.");
    if (typeof min === "number" && typeof max === "number" && min > max) throw new TypeError("Number min cannot exceed max.");
    if ((typeof min === "number" && item.defaultValue < min) || (typeof max === "number" && item.defaultValue > max)) throw new TypeError("Number default is outside its bounds.");
    return Object.freeze({ type, ...common, defaultValue: item.defaultValue, ...(min === undefined ? {} : { min: min as number }), ...(max === undefined ? {} : { max: max as number }), ...(step === undefined ? {} : { step: step as number }) });
  }
  if (type === "select") {
    if (typeof item.defaultValue !== "string" || !Array.isArray(item.options) || item.options.length < 1 || item.options.length > 32) throw new TypeError("Select settings require 1–32 options and a string default.");
    const options = item.options.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new TypeError("Select options must be objects.");
      const option = entry as Record<string, unknown>;
      return Object.freeze({ label: text(option.label, "Option label", 80)!, value: text(option.value, "Option value", 128)! });
    });
    if (new Set(options.map((option) => option.value)).size !== options.length || !options.some((option) => option.value === item.defaultValue)) throw new TypeError("Select options must have unique values and include the default.");
    return Object.freeze({ type, ...common, defaultValue: item.defaultValue, options: Object.freeze(options) });
  }
  throw new TypeError("Unsupported settings panel item type.");
}
export function validateSettingsPanel(input: unknown): SettingsPanelDefinition {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("Settings panel must be an object.");
  const panel = input as Record<string, unknown>;
  const id = identifier(panel.id, "settings panel ID");
  const title = text(panel.title, "Settings panel title", 80)!;
  const description = text(panel.description, "Settings panel description", 240, true);
  const icon = text(panel.icon, "Settings panel icon", 32, true);
  if (icon !== undefined && !ICONS.has(icon)) throw new TypeError("Unsupported settings panel icon.");
  if (!Array.isArray(panel.items) || panel.items.length > 64) throw new TypeError("Settings panels may contain at most 64 items.");
  const items = panel.items.map(validateItem);
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new TypeError("Settings panel item IDs must be unique.");
  const result = { id, title, items: Object.freeze(items), ...(description === undefined ? {} : { description }), ...(icon === undefined ? {} : { icon }) };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 12 * 1024) throw new TypeError("Settings panel definition exceeds 12 KiB.");
  return Object.freeze(result);
}
export class PluginSettingsPanelRegistry {
  readonly #panels = new Map<string, Map<string, RegisteredSettingsPanel>>();
  readonly #listeners = new Set<(panels: readonly RegisteredSettingsPanel[]) => void>();
  list(): readonly RegisteredSettingsPanel[] {
    return Object.freeze([...this.#panels.values()].flatMap((items) => [...items.values()]));
  }
  subscribe(listener: (panels: readonly RegisteredSettingsPanel[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  register(pluginId: string, input: unknown): () => void {
    if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(pluginId)) throw new TypeError("Invalid plugin ID.");
    const panel = validateSettingsPanel(input);
    let owned = this.#panels.get(pluginId);
    if (!owned) { owned = new Map(); this.#panels.set(pluginId, owned); }
    if (owned.has(panel.id)) throw new Error("This plugin already registered a panel with that ID.");
    if (owned.size >= 32) throw new RangeError("A plugin may register at most 32 settings panels.");
    const entry = Object.freeze({ pluginId, panel });
    owned.set(panel.id, entry);
    this.#emit();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.#panels.get(pluginId);
      if (current?.get(panel.id) !== entry) return;
      current.delete(panel.id);
      if (current.size === 0) this.#panels.delete(pluginId);
      this.#emit();
    };
  }
  unregisterPlugin(pluginId: string): void {
    if (this.#panels.delete(pluginId)) this.#emit();
  }
  #emit(): void {
    const snapshot = this.list();
    for (const listener of [...this.#listeners]) {
      try { listener(snapshot); } catch { /* host UI observers are isolated */ }
    }
  }
}
