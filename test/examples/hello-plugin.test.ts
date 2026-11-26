import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PluginApprovalController } from "../../src/plugins/approval-controller.js";
import { discoverPlugins } from "../../src/plugins/discovery.js";
import { readPluginEntry } from "../../src/runtime/electron-execution.js";

const exampleDirectory = fileURLToPath(new URL("../../examples/hello-plugin/", import.meta.url));

test("Hello example is a zero-permission plugin and subscribes to application readiness", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "yplusplus-hello-plugin-"));
  const pluginRoot = path.join(temporary, "plugins");
  const pluginDirectory = path.join(pluginRoot, "hello-plugin");
  await mkdir(pluginDirectory, { recursive: true });
  try {
    await cp(exampleDirectory, pluginDirectory, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(pluginDirectory, "yplusplus.plugin.json"), "utf8")) as {
      id: string; version: string; permissions: string[];
    };
    assert.equal(manifest.id, "dev.yplusplus.hello");
    assert.deepEqual(manifest.permissions, []);

    const discovery = await discoverPlugins(pluginRoot);
    assert.equal(discovery.rejected.length, 0);
    assert.equal(discovery.plugins.length, 1);
    const approvals = new PluginApprovalController({
      storeOptions: { filePath: path.join(temporary, "permissions.json") },
      trustStoreOptions: { filePath: path.join(temporary, "trusted-plugins.json") },
    });
    let report = await approvals.inspect(discovery);
    assert.equal(report.plugins[0]?.state, "WAITING_FOR_TRUST");
    await approvals.trust(discovery.plugins[0]!);
    report = await approvals.inspect(discovery);
    assert.equal(report.plugins[0]?.state, "READY");

    const source = await readPluginEntry(report.plugins[0]!);
    assert.match(source, /api\.events\.on\("application\.ready"/);
    assert.match(source, /api\.audio\.playStartup\(\)/);
    assert.doesNotMatch(source, /https?:\/\//);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
