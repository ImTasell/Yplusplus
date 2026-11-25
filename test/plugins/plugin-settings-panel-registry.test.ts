import assert from "node:assert/strict";
import test from "node:test";
import { PluginSettingsPanelRegistry, validateSettingsPanel } from "../../src/plugins/plugin-settings-panel-registry.js";

const panel = {
  id: "general",
  title: "General",
  description: "Plugin preferences",
  icon: "settings",
  items: [
    { type: "toggle", id: "enabled", label: "Enabled", defaultValue: true },
    { type: "text", id: "nickname", label: "Nickname", defaultValue: "Y++", maxLength: 32 },
    { type: "number", id: "scale", label: "Scale", defaultValue: 1, min: 0.5, max: 2, step: 0.1 },
    { type: "select", id: "mode", label: "Mode", defaultValue: "fast", options: [
      { label: "Fast", value: "fast" }, { label: "Safe", value: "safe" },
    ] },
  ],
};

test("validates and freezes a declarative settings panel", () => {
  const result = validateSettingsPanel(panel);
  assert.equal(result.id, "general");
  assert.equal(result.items.length, 4);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.items), true);
});

test("rejects unsupported types, invalid bounds, duplicate IDs, and unsupported icons", () => {
  assert.throws(() => validateSettingsPanel({ ...panel, icon: "arbitrary-svg" }), /icon/);
  assert.throws(() => validateSettingsPanel({ ...panel, items: [{ type: "html", id: "x", label: "X" }] }), /Unsupported/);
  assert.throws(() => validateSettingsPanel({ ...panel, items: [{ type: "number", id: "x", label: "X", defaultValue: 10, max: 2 }] }), /bounds/);
  assert.throws(() => validateSettingsPanel({ ...panel, items: [panel.items[0], panel.items[0]] }), /unique/);
  assert.throws(() => validateSettingsPanel({ ...panel, items: [{ type: "select", id: "x", label: "X", defaultValue: "missing", options: [{ label: "A", value: "a" }] }] }), /include the default/);
});

test("registry isolates plugin ownership and notifies observers", () => {
  const registry = new PluginSettingsPanelRegistry();
  const updates: number[] = [];
  const unsubscribe = registry.subscribe((items) => updates.push(items.length));
  const dispose = registry.register("dev.example.first", panel);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0]?.pluginId, "dev.example.first");
  assert.throws(() => registry.register("dev.example.first", panel), /already registered/);
  registry.register("dev.example.second", panel);
  assert.equal(registry.list().length, 2);
  dispose();
  assert.equal(registry.list().length, 1);
  registry.unregisterPlugin("dev.example.second");
  assert.equal(registry.list().length, 0);
  unsubscribe();
  assert.deepEqual(updates, [1, 2, 1, 0]);
});

test("registration disposer is idempotent", () => {
  const registry = new PluginSettingsPanelRegistry();
  let changes = 0;
  registry.subscribe(() => { changes += 1; });
  const dispose = registry.register("dev.example.plugin", panel);
  dispose();
  dispose();
  assert.equal(changes, 2);
  assert.equal(registry.list().length, 0);
});
