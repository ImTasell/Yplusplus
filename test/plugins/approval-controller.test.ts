import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { PluginApprovalStore } from "../../src/capabilities/approval-store.js";
import { PluginApprovalController } from "../../src/plugins/approval-controller.js";
import { PluginTrustStore } from "../../src/plugins/trust-store.js";
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
  const trustStore = new PluginTrustStore({ filePath: path.join(root, "config", "trusted-plugins.json") });
  const controller = new PluginApprovalController({ store, trustStore });
  return { root, plugin, discovery, store, trustStore, controller };
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

test("new plugins wait for explicit trust, even when they request no capabilities", async () => {
  const { discovery, controller } = await setup(manifest({ permissions: [] }));
  const report = await controller.inspect(discovery);
  assert.equal(report.plugins[0]?.state, "WAITING_FOR_TRUST");
  assert.equal(report.counts.waitingForTrust, 1);
});

test("an explicitly trusted zero-permission plugin becomes READY", async () => {
  const { discovery, plugin, controller } = await setup(manifest({ permissions: [] }));
  await controller.trust(plugin);
  const report = await controller.inspect(discovery);
  assert.equal(report.plugins[0]?.state, "READY");
  assert.equal(report.plugins[0]?.trusted, true);
  assert.deepEqual(report.plugins[0]?.approvedPermissions, []);
});

test("trusting a release persists execution trust but grants no capabilities", async () => {
  const { discovery, plugin, controller, store, trustStore } = await setup(manifest());
  await controller.trust(plugin);
  assert.equal(await trustStore.isTrusted(plugin.manifest.id, plugin.manifest.version), true);
  assert.deepEqual([...await store.getApprovedPermissions(plugin.manifest.id, plugin.manifest.version)], []);
  assert.equal((await controller.inspect(discovery)).plugins[0]?.state, "WAITING_FOR_APPROVAL");
});

test("explicit capability approval after trust moves plugin to READY", async () => {
  const { discovery, plugin, controller } = await setup(manifest());
  await controller.trust(plugin);
  await controller.approve(plugin, ["ui.notifications"]);
  const report = await controller.inspect(discovery);
  assert.equal(report.plugins[0]?.state, "READY");
  assert.equal(report.plugins[0]?.trusted, true);
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

test("trust and approval both reject incompatible plugin API versions", async () => {
  const { plugin, controller, store, trustStore } = await setup(manifest({ apiVersion: 2 }));
  await assert.rejects(controller.trust(plugin), /supports version/);
  await assert.rejects(controller.approve(plugin, ["ui.notifications"]), /supports version/);
  assert.deepEqual([...await store.getApprovedPermissions(plugin.manifest.id, plugin.manifest.version)], []);
  assert.equal(await trustStore.isTrusted(plugin.manifest.id, plugin.manifest.version), false);
});

test("revoking a capability returns a trusted plugin to WAITING_FOR_APPROVAL", async () => {
  const { discovery, plugin, controller } = await setup(manifest());
  await controller.trust(plugin);
  await controller.approve(plugin, ["ui.notifications"]);
  assert.equal((await controller.inspect(discovery)).plugins[0]?.state, "READY");
  await controller.revoke(plugin.manifest.id, plugin.manifest.version, ["ui.notifications"]);
  assert.equal((await controller.inspect(discovery)).plugins[0]?.state, "WAITING_FOR_APPROVAL");
});

test("revoking execution trust stops a plugin regardless of capability grants", async () => {
  const { discovery, plugin, controller } = await setup(manifest());
  await controller.trust(plugin);
  await controller.approve(plugin, ["ui.notifications"]);
  assert.equal((await controller.inspect(discovery)).plugins[0]?.state, "READY");
  await controller.untrust(plugin.manifest.id, plugin.manifest.version);
  assert.equal((await controller.inspect(discovery)).plugins[0]?.state, "WAITING_FOR_TRUST");
});

test("plugin-wide trust revocation removes trust for every release", async () => {
  const { plugin, controller, trustStore } = await setup(manifest());
  await controller.trust(plugin);
  await trustStore.trust(plugin.manifest.id, "2.0.0");
  await controller.untrustPlugin(plugin.manifest.id);
  assert.equal(await trustStore.isTrusted(plugin.manifest.id, "1.0.0"), false);
  assert.equal(await trustStore.isTrusted(plugin.manifest.id, "2.0.0"), false);
});

test("capability release-wide and plugin-wide revocation remain separate", async () => {
  const { plugin, controller, store, trustStore } = await setup(manifest());
  await controller.trust(plugin);
  await controller.approve(plugin, ["ui.notifications"]);
  await store.grantPermissions(plugin.manifest.id, "2.0.0", ["ui.notifications"]);
  await controller.revokePlugin(plugin.manifest.id);
  assert.deepEqual([...await store.getApprovedPermissions(plugin.manifest.id, "1.0.0")], []);
  assert.deepEqual([...await store.getApprovedPermissions(plugin.manifest.id, "2.0.0")], []);
  assert.equal(await trustStore.isTrusted(plugin.manifest.id, "1.0.0"), true);
});

test("controller rejects an invalid host API version at construction", async () => {
  assert.throws(() => new PluginApprovalController({ hostApiVersion: 0 }), RangeError);
});
