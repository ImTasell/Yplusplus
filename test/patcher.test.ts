import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAsar, makeIntegrity, parseAsar, readAsarFile } from "../src/asar.js";
import { PATCH_MARKER, patchAsarBuffer } from "../src/patcher.js";

const PACKAGE = Buffer.from(JSON.stringify({ name: "yapper-desktop", version: "1.2.7" }));
const MAIN = Buffer.from([
  "const { app, session } = require('electron');",
  "const path = require('node:path');",
  "app.whenReady().then(() => {",
  "  const ses = session.defaultSession;",
  "  ses.setPermissionRequestHandler(() => {});",
  "});"
].join("\n"));
const EXISTING_PRELOAD = Buffer.from("existing Yapper preload must remain untouched");

function makeYapperArchive(version = "1.2.7", main = MAIN): Buffer {
  const packageJson = Buffer.from(JSON.stringify({ name: "yapper-desktop", version }));
  const header = {
    files: {
      "package.json": { size: packageJson.length, offset: "0", integrity: makeIntegrity(packageJson) },
      "main.js": { size: main.length, offset: String(packageJson.length), integrity: makeIntegrity(main) },
      "preload.js": {
        size: EXISTING_PRELOAD.length,
        offset: String(packageJson.length + main.length),
        integrity: makeIntegrity(EXISTING_PRELOAD)
      }
    }
  };
  return encodeAsar(header, Buffer.concat([packageJson, main, EXISTING_PRELOAD]));
}

test("patches the known Yapper anchor and adds a separate preload", () => {
  const result = patchAsarBuffer(makeYapperArchive());
  assert.equal(result.status, "patched");

  const archive = parseAsar(result.buffer);
  const main = readAsarFile(archive, "main.js").toString("utf8");
  const preload = readAsarFile(archive, "yplusplus-preload.cjs").toString("utf8");
  const originalPreload = readAsarFile(archive, "preload.js");

  assert.ok(main.includes(PATCH_MARKER));
  assert.ok(main.includes("registerPreloadScript"));
  assert.ok(main.includes("path.join(__dirname, 'yplusplus-preload.cjs')"));
  assert.ok(preload.includes("contextBridge.exposeInMainWorld"));
  assert.ok(preload.includes("process.isMainFrame"));
  assert.deepEqual(originalPreload, EXISTING_PRELOAD);
});

test("patch is idempotent", () => {
  const first = patchAsarBuffer(makeYapperArchive());
  const second = patchAsarBuffer(first.buffer);
  assert.equal(first.status, "patched");
  assert.equal(second.status, "already-patched");
  assert.deepEqual(second.buffer, first.buffer);
});

test("refuses an unsupported Yapper version", () => {
  assert.throws(() => patchAsarBuffer(makeYapperArchive("1.2.8")), /only supports 1.2.7/);
});

test("refuses an unknown main-process anchor without changing the input", () => {
  const original = makeYapperArchive("1.2.7", Buffer.from("const ses = session.defaultSession;"));
  const before = Buffer.from(original);
  assert.throws(() => patchAsarBuffer(original), /anchor mismatch/);
  assert.deepEqual(original, before);
});

test("refuses to overwrite an unrecognized preload entry", () => {
  const archive = parseAsar(makeYapperArchive());
  archive.header.files["yplusplus-preload.cjs"] = {
    size: 1,
    offset: "0",
    integrity: makeIntegrity(Buffer.from("x"))
  };
  assert.throws(() => patchAsarBuffer(encodeAsar(archive.header, archive.data)), /without a recognized Y\+\+ patch marker/);
});
