import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ApprovalStoreError, PluginApprovalStore } from "../../src/capabilities/approval-store.js";

const roots: string[] = [];
async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), "yplusplus-approvals-"));
  roots.push(root);
  return { root, store: new PluginApprovalStore({ filePath: join(root, "config", "permissions.json") }) };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("new store returns no approvals without creating a file", async () => {
  const { store } = await makeStore();
  assert.deepEqual([...await store.getApprovedPermissions("dev.example.test", "1.0.0")], []);
});

test("grants persist across store instances and are scoped to exact plugin version", async () => {
  const { store } = await makeStore();
  await store.grantPermissions("dev.example.test", "1.0.0", ["ui.notifications"]);
  const reopened = new PluginApprovalStore({ filePath: store.filePath });
  assert.deepEqual([...await reopened.getApprovedPermissions("dev.example.test", "1.0.0")], ["ui.notifications"]);
  assert.deepEqual([...await reopened.getApprovedPermissions("dev.example.test", "1.1.0")], []);
});

test("grants are deduplicated and sorted", async () => {
  const { store } = await makeStore();
  await store.grantPermissions("dev.example.test", "1.0.0", ["ui.notifications", "ui.notifications"]);
  assert.deepEqual([...await store.getApprovedPermissions("dev.example.test", "1.0.0")], ["ui.notifications"]);
});

test("individual grants can be revoked", async () => {
  const { store } = await makeStore();
  await store.grantPermissions("dev.example.test", "1.0.0", ["ui.notifications", "ui.settings"]);
  await store.revokePermissions("dev.example.test", "1.0.0", ["ui.notifications"]);
  assert.deepEqual([...await store.getApprovedPermissions("dev.example.test", "1.0.0")], ["ui.settings"]);
});

test("all grants for one release can be revoked", async () => {
  const { store } = await makeStore();
  await store.grantPermissions("dev.example.test", "1.0.0", ["ui.notifications"]);
  await store.revokePermissions("dev.example.test", "1.0.0");
  assert.deepEqual([...await store.getApprovedPermissions("dev.example.test", "1.0.0")], []);
});

test("all versions for one plugin can be revoked without affecting another plugin", async () => {
  const { store } = await makeStore();
  await store.grantPermissions("dev.example.test", "1.0.0", ["ui.notifications"]);
  await store.grantPermissions("dev.example.test", "2.0.0", ["ui.notifications"]);
  await store.grantPermissions("dev.other.test", "1.0.0", ["ui.notifications"]);
  await store.revokePlugin("dev.example.test");
  assert.deepEqual([...await store.getApprovedPermissions("dev.example.test", "1.0.0")], []);
  assert.deepEqual([...await store.getApprovedPermissions("dev.other.test", "1.0.0")], ["ui.notifications"]);
});

test("concurrent mutations are serialized without lost updates", async () => {
  const { store } = await makeStore();
  await Promise.all([
    store.grantPermissions("dev.example.test", "1.0.0", ["ui.notifications"]),
    store.grantPermissions("dev.other.test", "1.0.0", ["ui.notifications"]),
  ]);
  assert.deepEqual([...await store.getApprovedPermissions("dev.example.test", "1.0.0")], ["ui.notifications"]);
  assert.deepEqual([...await store.getApprovedPermissions("dev.other.test", "1.0.0")], ["ui.notifications"]);
});

test("writes a private file and directory", async () => {
  const { root, store } = await makeStore();
  await store.grantPermissions("dev.example.test", "1.0.0", ["ui.notifications"]);
  const fileInfo = await stat(store.filePath);
  const dirInfo = await stat(join(root, "config"));
  assert.equal(fileInfo.mode & 0o777, 0o600);
  assert.equal(dirInfo.mode & 0o777, 0o700);
});

test("malformed JSON fails closed and is not overwritten", async () => {
  const { store } = await makeStore();
  await (await import("node:fs/promises")).mkdir(join(store.filePath, ".."), { recursive: true });
  await writeFile(store.filePath, "{broken", { mode: 0o600 });
  await assert.rejects(store.getApprovedPermissions("dev.example.test", "1.0.0"), ApprovalStoreError);
  await assert.rejects(store.grantPermissions("dev.example.test", "1.0.0", ["ui.notifications"]), ApprovalStoreError);
  assert.equal(await readFile(store.filePath, "utf8"), "{broken");
});

test("symlinked store files are rejected", async () => {
  const { root, store } = await makeStore();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "config"), { recursive: true });
  const target = join(root, "target.json");
  await writeFile(target, JSON.stringify({ storeVersion: 1, records: [] }), { mode: 0o600 });
  await symlink(target, store.filePath);
  await assert.rejects(store.getApprovedPermissions("dev.example.test", "1.0.0"), ApprovalStoreError);
});

test("invalid plugin identity and capability inputs are rejected", async () => {
  const { store } = await makeStore();
  await assert.rejects(store.grantPermissions("../bad", "1.0.0", ["ui.notifications"]), TypeError);
  await assert.rejects(store.grantPermissions("dev.example.test", "latest", ["ui.notifications"]), TypeError);
  await assert.rejects(store.grantPermissions("dev.example.test", "1.0.0", ["Node"]), TypeError);
});

test("corrupt schema fails closed", async () => {
  const { store } = await makeStore();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(store.filePath, ".."), { recursive: true });
  await writeFile(store.filePath, JSON.stringify({ storeVersion: 99, records: [] }), { mode: 0o600 });
  await assert.rejects(store.getApprovedPermissions("dev.example.test", "1.0.0"), ApprovalStoreError);
});

test("approval store refuses files with group or world permissions", async () => {
  const { store } = await makeStore();
  const { mkdir, chmod } = await import("node:fs/promises");
  await mkdir(join(store.filePath, ".."), { recursive: true });
  await writeFile(store.filePath, JSON.stringify({ storeVersion: 1, records: [] }), { mode: 0o600 });
  await chmod(store.filePath, 0o644);
  await assert.rejects(store.getApprovedPermissions("dev.example.test", "1.0.0"), ApprovalStoreError);
});
