import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PluginApprovalController } from "../../src/plugins/approval-controller.js";
import { discoverPlugins } from "../../src/plugins/discovery.js";
import { readPluginEntry } from "../../src/runtime/electron-execution.js";

const exampleDirectory = fileURLToPath(new URL("../../examples/notification-plugin/", import.meta.url));

test("notification example completes discovery, trust, approval, and entry validation", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "yplusplus-example-plugin-"));
  const pluginRoot = path.join(temporary, "plugins");
  const pluginDirectory = path.join(pluginRoot, "notification-plugin");
  await mkdir(pluginDirectory, { recursive: true });

  try {
    await cp(exampleDirectory, pluginDirectory, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(pluginDirectory, "yplusplus.plugin.json"), "utf8")) as {
      id: string;
      version: string;
      permissions: string[];
    };
    assert.equal(manifest.id, "dev.example.notification");
    assert.deepEqual(manifest.permissions, ["ui.notifications"]);

    const discovery = await discoverPlugins(pluginRoot);
    assert.equal(discovery.rejected.length, 0);
    assert.equal(discovery.plugins.length, 1);

    const controller = new PluginApprovalController({
      storeOptions: { filePath: path.join(temporary, "permissions.json") },
      trustStoreOptions: { filePath: path.join(temporary, "trusted-plugins.json") },
    });

    let report = await controller.inspect(discovery);
    assert.equal(report.plugins[0]?.state, "WAITING_FOR_TRUST");

    await controller.trust(discovery.plugins[0]!);
    report = await controller.inspect(discovery);
    assert.equal(report.plugins[0]?.state, "WAITING_FOR_APPROVAL");

    await controller.approve(discovery.plugins[0]!, ["ui.notifications"]);
    report = await controller.inspect(discovery);
    const ready = report.plugins[0]!;
    assert.equal(ready.state, "READY");
    assert.equal(ready.trusted, true);
    assert.deepEqual(ready.approvedPermissions, ["ui.notifications"]);

    const source = await readPluginEntry(ready);
    assert.match(source, /export async function activate\(\)/);
    assert.match(source, /globalThis\.yplusplus\?\.notifications/);
    assert.match(source, /globalThis\.yplusplus\.notifications\.show/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
