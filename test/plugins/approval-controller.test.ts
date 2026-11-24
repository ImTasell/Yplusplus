import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { PluginApprovalStore } from "../../src/capabilities/approval-store.js";
import { PluginApprovalController } from "../../src/plugins/approval-controller.js";
import { discoverPlugins } from "../../src/plugins/discovery.js";

const roots: string[] = [];
async function setup(manifest: Record<string, unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "yplusplus-approval-flow-"));
  roots.push(root);
  const pluginDir = path.join(root, "plugin");
  await mkdir(pluginDir);
  await writeFile(path.join(pluginDir, "index.js"), "// inert plugin");
  await writeFile(path.join(pluginDir, "yplusplus.plugin.json"), JSON.stringify(manifest));
  const discovery = await discoverPlugins(root);
  const plugin = discovery.plugins[0]!;
  const store = new PluginApprovalStore({ filePath: path.join(root, "config", "permissions.json") });
  const controller = new PluginApprovalController({ store });
  return { root, plugin, discovery, store, controller };
}
const manifest = (overrides: Record<string, unknown> = {}) => ({
  manifestVersion: 1,
  id: "dev.example.flow",
  name: "Approval flow fixture",
  version: "1.0.0",
  description: "Test plugin",
  apiVersion: 1,
  entry: "index.js",
  permissions: ["ui.notifications"],
  ...overrides,
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("controller initially reports requested capabilities as waiting", async () => {
  const { discovery, controller } = await setup(manifest());
  const report = await controller.inspect(discovery);
  assert.equal(report.plugins[0]?.state, "WAITING_FOR_APPROVAL");
});

test("explicit approval persists and moves plugin to READY on reinspection", async () => {
  const { discovery, plugin, controller } = await setup(manifest());
  await controller.approve(plugin, ["ui.notifications"]);
  const report = await controller.inspect(discovery);
  assert.equal(report.plugins[0]?.state, "READY");
  assert.deepEqual(report.plugins[0]?.approvedPermissions, ["ui.notifications"]);
});

test("approval rejects capabilities the plugin did not request", async () => {
  const { plugin, controller, store } = await setup(manifest());
  await assert.rejects(controller.approve(plugin, ["filesystem.read"]), /did not request/);
  assert.deepEqual([...await store.getApprovedPermissions(plugin.manifest.id, plugin.manifest.version)], []);
});

test("approval rejects unsupported capability identifiers", async () => {
  const { plugin, controller, store } = await setup(manifest({ permissions: ["ui.experimental"] }));
  await assert.rejects(controller.approve(plugin, ["ui.experimental"]), /unsupported capability/);
  assert.deepEqual([...await store.getApprovedPermissions(plugin.manifest.id, plugin.manifest.version)], []);
});

test("approval rejects incompatible plugin API versions", async () => {
  const { plugin, controller, store } = await setup(manifest({ apiVersion: 2 }));
  await assert.rejects(controller.approve(plugin, ["ui.notifications"]), /supports version/);
  assert.deepEqual([...await store.getApprovedPermissions(plugin.manifest.id, plugin.manifest.version)], []);
});

test("revoking a capability returns the plugin to WAITING_FOR_APPROVAL", async () => {
  const { discovery, plugin, controller } = await setup(manifest());
  await controller.approve(plugin, ["ui.notifications"]);
  assert.equal((await controller.inspect(discovery)).plugins[0]?.state, "READY");
  await controller.revoke(plugin.manifest.id, plugin.manifest.version, ["ui.notifications"]);
  assert.equal((await controller.inspect(discovery)).plugins[0]?.state, "WAITING_FOR_APPROVAL");
});

test("release-wide revocation removes all capabilities for that version", async () => {
  const { plugin, controller, store } = await setup(manifest());
  await controller.approve(plugin, ["ui.notifications"]);
  await controller.revoke(plugin.manifest.id, plugin.manifest.version);
  assert.deepEqual([...await store.getApprovedPermissions(plugin.manifest.id, plugin.manifest.version)], []);
});

test("plugin-wide revocation removes approvals for every release", async () => {
  const { plugin, controller, store } = await setup(manifest());
  await controller.approve(plugin, ["ui.notifications"]);
  await store.grantPermissions(plugin.manifest.id, "2.0.0", ["ui.notifications"]);
  await controller.revokePlugin(plugin.manifest.id);
  assert.deepEqual([...await store.getApprovedPermissions(plugin.manifest.id, "1.0.0")], []);
  assert.deepEqual([...await store.getApprovedPermissions(plugin.manifest.id, "2.0.0")], []);
});

test("controller rejects an invalid host API version at construction", async () => {
  assert.throws(() => new PluginApprovalController({ hostApiVersion: 0 }), RangeError);
});
