import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { PluginTrustStore } from "../../src/plugins/trust-store.js";

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "yplusplus-trust-store-"));
  roots.push(root);
  return { root, store: new PluginTrustStore({ filePath: path.join(root, "config", "trusted-plugins.json") }) };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("missing trust store is empty and does not create files", async () => {
  const { root, store } = await setup();
  assert.equal(await store.isTrusted("dev.example.plugin", "1.0.0"), false);
  await assert.rejects(readFile(path.join(root, "config")));
});

test("trust decisions persist and are scoped to an exact release", async () => {
  const { store } = await setup();
  await store.trust("dev.example.plugin", "1.0.0");
  assert.equal(await store.isTrusted("dev.example.plugin", "1.0.0"), true);
  assert.equal(await store.isTrusted("dev.example.plugin", "1.0.1"), false);
  const second = new PluginTrustStore({ filePath: store.filePath });
  assert.equal(await second.isTrusted("dev.example.plugin", "1.0.0"), true);
});

test("untrust removes one release while plugin-wide untrust removes every release", async () => {
  const { store } = await setup();
  await store.trust("dev.example.plugin", "1.0.0");
  await store.trust("dev.example.plugin", "2.0.0");
  await store.untrust("dev.example.plugin", "1.0.0");
  assert.equal(await store.isTrusted("dev.example.plugin", "1.0.0"), false);
  assert.equal(await store.isTrusted("dev.example.plugin", "2.0.0"), true);
  await store.untrustPlugin("dev.example.plugin");
  assert.equal(await store.isTrusted("dev.example.plugin", "2.0.0"), false);
});

test("concurrent trust mutations are serialized without losing records", async () => {
  const { store } = await setup();
  await Promise.all([
    store.trust("dev.example.one", "1.0.0"),
    store.trust("dev.example.two", "1.0.0"),
    store.trust("dev.example.three", "1.0.0"),
  ]);
  for (const id of ["dev.example.one", "dev.example.two", "dev.example.three"]) {
    assert.equal(await store.isTrusted(id, "1.0.0"), true);
  }
});

test("trust store is written with private directory and file modes", async () => {
  const { root, store } = await setup();
  await store.trust("dev.example.plugin", "1.0.0");
  const dir = await (await import("node:fs/promises")).stat(path.dirname(store.filePath));
  const file = await (await import("node:fs/promises")).stat(store.filePath);
  assert.equal(dir.mode & 0o777, 0o700);
  assert.equal(file.mode & 0o777, 0o600);
  assert.equal(path.dirname(store.filePath), path.join(root, "config"));
});

test("symlink trust store fails closed", async () => {
  const { root, store } = await setup();
  const target = path.join(root, "target.json");
  await writeFile(target, JSON.stringify({ storeVersion: 1, trusted: [] }));
  await chmod(target, 0o600);
  await symlink(target, store.filePath);
  await assert.rejects(store.isTrusted("dev.example.plugin", "1.0.0"), /Unable to read plugin trust store/);
});

test("invalid plugin identities and versions are rejected", async () => {
  const { store } = await setup();
  await assert.rejects(store.trust("../plugin", "1.0.0"), /Invalid plugin ID/);
  await assert.rejects(store.trust("dev.example.plugin", "latest"), /Invalid plugin version/);
});
