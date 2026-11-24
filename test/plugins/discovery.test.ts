import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverPlugins } from "../../src/plugins/discovery.js";

const manifest = (id: string) => ({
  manifestVersion: 1,
  id,
  name: "Fixture plugin",
  version: "1.0.0",
  description: "Temporary plugin used by discovery tests.",
  apiVersion: 1,
  entry: "dist/index.js",
  permissions: [],
});

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "yplusplus-discovery-"));
}

async function addPlugin(root: string, folder: string, value: unknown): Promise<string> {
  const directory = path.join(root, folder);
  await mkdir(path.join(directory, "dist"), { recursive: true });
  await writeFile(path.join(directory, "dist", "index.js"), "export {};", "utf8");
  await writeFile(
    path.join(directory, "yplusplus.plugin.json"),
    JSON.stringify(value) ?? "null",
    "utf8",
  );
  return directory;
}

test("discovers valid plugins in deterministic folder order without executing entries", async () => {
  const root = await makeRoot();
  try {
    await addPlugin(root, "zeta", manifest("dev.example.zeta"));
    await addPlugin(root, "alpha", manifest("dev.example.alpha"));

    const report = await discoverPlugins(root);
    assert.deepEqual(report.plugins.map((plugin) => path.basename(plugin.directory)), ["alpha", "zeta"]);
    assert.equal(report.rejected.length, 0);
    assert.equal(report.plugins[0]?.manifest.id, "dev.example.alpha");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports malformed JSON and missing manifests while continuing other plugins", async () => {
  const root = await makeRoot();
  try {
    await addPlugin(root, "good", manifest("dev.example.good"));
    const malformed = path.join(root, "malformed");
    const missing = path.join(root, "missing");
    await mkdir(malformed);
    await mkdir(missing);
    await writeFile(path.join(malformed, "yplusplus.plugin.json"), "{ nope", "utf8");

    const report = await discoverPlugins(root);
    assert.deepEqual(report.plugins.map((plugin) => plugin.manifest.id), ["dev.example.good"]);
    assert.ok(report.rejected.some((item) => item.issues.some((issue) => issue.code === "manifest-json")));
    assert.ok(report.rejected.some((item) => item.issues.some((issue) => issue.code === "missing-manifest")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid manifests and missing entry points", async () => {
  const root = await makeRoot();
  try {
    await addPlugin(root, "bad-schema", { ...manifest("dev.example.bad"), extra: true });
    const missingEntry = manifest("dev.example.missing");
    missingEntry.entry = "dist/absent.js";
    await addPlugin(root, "missing-entry", missingEntry);

    const report = await discoverPlugins(root);
    assert.equal(report.plugins.length, 0);
    assert.ok(report.rejected.some((item) => item.issues.some((issue) => issue.code === "manifest-invalid")));
    assert.ok(report.rejected.some((item) => item.issues.some((issue) => issue.code === "entry-missing")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects every directory that declares a duplicate plugin ID", async () => {
  const root = await makeRoot();
  try {
    await addPlugin(root, "copy-a", manifest("dev.example.duplicate"));
    await addPlugin(root, "copy-b", manifest("dev.example.duplicate"));

    const report = await discoverPlugins(root);
    assert.equal(report.plugins.length, 0);
    assert.equal(
      report.rejected.filter((item) => item.issues.some((issue) => issue.code === "duplicate-id")).length,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects entry symlinks that escape the plugin directory", async () => {
  const root = await makeRoot();
  const outside = await makeRoot();
  try {
    const directory = await addPlugin(root, "escape", manifest("dev.example.escape"));
    await writeFile(path.join(outside, "outside.js"), "globalThis.pwned = true;", "utf8");
    await rm(path.join(directory, "dist", "index.js"));
    await symlink(path.join(outside, "outside.js"), path.join(directory, "dist", "index.js"));

    const report = await discoverPlugins(root);
    assert.equal(report.plugins.length, 0);
    assert.ok(report.rejected.some((item) => item.issues.some((issue) => issue.code === "entry-escapes-root")));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("ignores symlinked plugin directories", async () => {
  const root = await makeRoot();
  const outside = await makeRoot();
  try {
    await addPlugin(outside, "linked", manifest("dev.example.linked"));
    await symlink(path.join(outside, "linked"), path.join(root, "linked"), "dir");

    const report = await discoverPlugins(root);
    assert.equal(report.plugins.length, 0);
    assert.equal(report.rejected.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("throws when the plugin root does not exist", async () => {
  const root = path.join(os.tmpdir(), `yplusplus-no-root-${process.pid}-${Date.now()}`);
  await assert.rejects(discoverPlugins(root));
});
