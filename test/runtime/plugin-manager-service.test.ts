import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { PluginApprovalStore } from "../../src/capabilities/approval-store.js";
import { PluginApprovalController } from "../../src/plugins/approval-controller.js";
import { PluginTrustStore } from "../../src/plugins/trust-store.js";
import { PluginEnabledStore } from "../../src/plugins/plugin-enabled-store.js";
import { PluginManagerService } from "../../src/runtime/plugin-manager-service.js";
import type { PluginRuntimeHost } from "../../src/runtime/host.js";

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "yplusplus-manager-service-"));
  roots.push(root);
  const pluginRoot = path.join(root, "plugins");
  const pluginDir = path.join(pluginRoot, "notification");
  const config = path.join(root, "config");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, "index.js"), "export async function activate() {}");
  await writeFile(path.join(pluginDir, "yplusplus.plugin.json"), JSON.stringify({
    manifestVersion: 1,
    id: "dev.example.notification",
    name: "Notification Example",
    version: "1.0.0",
    description: "manager fixture",
    apiVersion: 1,
    entry: "index.js",
    permissions: ["ui.notifications"],
  }));

  let runtimeState: "ACTIVE" | "UNLOADED" | undefined;
  let starts = 0;
  let unloads = 0;
  const runtime = {
    get: () => runtimeState ? { id: "dev.example.notification", version: "1.0.0", state: runtimeState } : undefined,
    list: () => runtimeState ? [{ id: "dev.example.notification", version: "1.0.0", state: runtimeState }] : [],
    start: async (plugin: { readonly trusted?: boolean; readonly state: string }) => {
      assert.equal(plugin.trusted, true);
      assert.equal(plugin.state, "READY");
      starts += 1;
      runtimeState = "ACTIVE";
      return { id: "dev.example.notification", version: "1.0.0", state: "ACTIVE" as const };
    },
    unload: async () => {
      if (runtimeState && runtimeState !== "UNLOADED") unloads += 1;
      runtimeState = "UNLOADED";
      return { id: "dev.example.notification", version: "1.0.0", state: "UNLOADED" as const };
    },
  } as unknown as PluginRuntimeHost;

  const approvals = new PluginApprovalController({
    store: new PluginApprovalStore({ filePath: path.join(config, "permissions.json") }),
    trustStore: new PluginTrustStore({ filePath: path.join(config, "trusted-plugins.json") }),
  });
  const enabledStore = new PluginEnabledStore({ filePath: path.join(config, "plugin-enabled.json") });
  return {
    pluginRoot,
    service: new PluginManagerService({ pluginRoot, approvals, runtime, enabledStore }),
    get starts() { return starts; },
    get unloads() { return unloads; },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("manager lists untrusted plugins without executing them", async () => {
  const fixture = await setup();
  const snapshot = await fixture.service.refresh();
  assert.equal(snapshot.plugins.length, 1);
  assert.equal(snapshot.plugins[0]?.state, "WAITING_FOR_TRUST");
  assert.equal(snapshot.plugins[0]?.trusted, false);
  assert.equal(fixture.starts, 0);
});

test("manager trust and capability approval remain separate and start only after both", async () => {
  const fixture = await setup();
  const trusted = await fixture.service.trust("dev.example.notification", "1.0.0");
  assert.equal(trusted.plugins[0]?.state, "WAITING_FOR_APPROVAL");
  assert.equal(fixture.starts, 0);

  const ready = await fixture.service.approve("dev.example.notification", "1.0.0", ["ui.notifications"]);
  assert.equal(ready.plugins[0]?.state, "READY");
  assert.equal(ready.plugins[0]?.runtimeState, "ACTIVE");
  assert.equal(fixture.starts, 1);
});

test("manager rejects capability escalation and revokes only the selected approval", async () => {
  const fixture = await setup();
  await fixture.service.trust("dev.example.notification", "1.0.0");
  await assert.rejects(
    fixture.service.approve("dev.example.notification", "1.0.0", ["filesystem.read"]),
    /did not request/,
  );
  await fixture.service.approve("dev.example.notification", "1.0.0", ["ui.notifications"]);
  const revoked = await fixture.service.revoke("dev.example.notification", "1.0.0", ["ui.notifications"]);
  assert.equal(revoked.plugins[0]?.state, "WAITING_FOR_APPROVAL");
  assert.deepEqual(revoked.plugins[0]?.approvedPermissions, []);
  assert.equal(revoked.plugins[0]?.runtimeState, "ACTIVE");
});

test("revoking trust immediately unloads the plugin runtime", async () => {
  const fixture = await setup();
  await fixture.service.trust("dev.example.notification", "1.0.0");
  await fixture.service.approve("dev.example.notification", "1.0.0", ["ui.notifications"]);
  const revoked = await fixture.service.untrust("dev.example.notification", "1.0.0");
  assert.equal(revoked.plugins[0]?.state, "WAITING_FOR_TRUST");
  assert.equal(revoked.plugins[0]?.runtimeState, "UNLOADED");
  assert.equal(fixture.unloads, 1);
});


test("enable switch persists state and stops or restarts only trusted, approved plugins", async () => {
  const fixture = await setup();
  const disabled = await fixture.service.setEnabled("dev.example.notification", "1.0.0", false);
  assert.equal(disabled.plugins[0]?.enabled, false);
  await fixture.service.trust("dev.example.notification", "1.0.0");
  const approved = await fixture.service.approve("dev.example.notification", "1.0.0", ["ui.notifications"]);
  assert.equal(approved.plugins[0]?.state, "READY");
  assert.equal(approved.plugins[0]?.enabled, false);
  assert.equal(fixture.starts, 0, "disabled plugin must not start after trust and approval");

  const enabled = await fixture.service.setEnabled("dev.example.notification", "1.0.0", true);
  assert.equal(enabled.plugins[0]?.enabled, true);
  assert.equal(enabled.plugins[0]?.runtimeState, "ACTIVE");
  assert.equal(fixture.starts, 1);

  const switchedOff = await fixture.service.setEnabled("dev.example.notification", "1.0.0", false);
  assert.equal(switchedOff.plugins[0]?.enabled, false);
  assert.equal(switchedOff.plugins[0]?.runtimeState, "UNLOADED");
  assert.equal(fixture.unloads, 1);
});
