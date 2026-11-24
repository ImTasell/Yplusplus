import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverPlugins } from "../../src/plugins/discovery.js";
import { inspectPlugins } from "../../src/plugins/manager.js";

const makeManifest = (id: string, apiVersion = 1, permissions: string[] = []) => ({
  manifestVersion: 1, id, name: id, version: "1.0.0",
  description: "Manager fixture", apiVersion, entry: "index.js", permissions,
});

async function fixture(root: string, folder: string, manifest: unknown): Promise<void> {
  const dir = path.join(root, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.js"), "// inert fixture", "utf8");
  await writeFile(path.join(dir, "yplusplus.plugin.json"), JSON.stringify(manifest), "utf8");
}

test("marks a permission-free compatible plugin READY without executing it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yplusplus-manager-"));
  try {
    await fixture(root, "simple", makeManifest("dev.example.simple"));
    const report = await inspectPlugins(await discoverPlugins(root), { getApprovedPermissions: async () => new Set() });
    assert.equal(report.plugins[0]?.state, "READY");
    assert.deepEqual(report.counts, {
      ready: 1, waitingForApproval: 0, incompatible: 0, approvalFailures: 0, rejectedDuringDiscovery: 0,
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("holds plugins with unapproved capabilities at WAITING_FOR_APPROVAL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yplusplus-manager-"));
  try {
    await fixture(root, "needs-permission", makeManifest("dev.example.permission", 1, ["ui.notifications"]));
    const report = await inspectPlugins(await discoverPlugins(root), { getApprovedPermissions: async () => new Set() });
    assert.equal(report.plugins[0]?.state, "WAITING_FOR_APPROVAL");
    assert.deepEqual(report.plugins[0]?.deniedPermissions, [{ id: "ui.notifications", reason: "not-approved" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("marks compatible and approved capability requests READY", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yplusplus-manager-"));
  try {
    await fixture(root, "approved", makeManifest("dev.example.approved", 1, ["ui.notifications"]));
    const report = await inspectPlugins(await discoverPlugins(root), {
      getApprovedPermissions: async () => new Set(["ui.notifications"]),
    });
    assert.equal(report.plugins[0]?.state, "READY");
    assert.deepEqual(report.plugins[0]?.approvedPermissions, ["ui.notifications"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects incompatible API generations before asking for approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yplusplus-manager-"));
  let approvalLookups = 0;
  try {
    await fixture(root, "future", makeManifest("dev.example.future", 2, ["ui.notifications"]));
    const report = await inspectPlugins(await discoverPlugins(root), {
      getApprovedPermissions: async () => { approvalLookups += 1; return new Set(["ui.notifications"]); },
    });
    assert.equal(report.plugins[0]?.state, "FAILED");
    assert.equal(report.plugins[0]?.issue?.code, "unsupported-api-version");
    assert.equal(approvalLookups, 0);
    assert.equal(report.counts.incompatible, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("isolates approval-provider failures and never treats them as grants", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yplusplus-manager-"));
  try {
    await fixture(root, "broken-store", makeManifest("dev.example.store", 1, ["ui.notifications"]));
    const report = await inspectPlugins(await discoverPlugins(root), {
      getApprovedPermissions: async () => { throw new Error("storage offline"); },
    });
    assert.equal(report.plugins[0]?.state, "FAILED");
    assert.deepEqual(report.plugins[0]?.approvedPermissions, []);
    assert.equal(report.plugins[0]?.issue?.code, "approval-provider-failed");
    assert.match(report.plugins[0]?.issue?.message ?? "", /storage offline/);
    assert.equal(report.counts.approvalFailures, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("preserves discovery rejections in the manager report", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "yplusplus-manager-"));
  try {
    await mkdir(path.join(root, "broken"));
    const report = await inspectPlugins(await discoverPlugins(root), { getApprovedPermissions: async () => new Set() });
    assert.equal(report.counts.rejectedDuringDiscovery, 1);
    assert.equal(report.rejected[0]?.issues[0]?.code, "missing-manifest");
  } finally { await rm(root, { recursive: true, force: true }); }
});
