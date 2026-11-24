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
  for (const pattern of [
    "https://www.yapper.website/*",
    "https://yapper.website/*",
    "https://www.yapin.gg/*",
    "https://yapin.gg/*"
  ]) {
    assert.ok(main.includes(pattern), "missing exact preload URL filter: " + pattern);
  }
  assert.ok(!main.includes("https://*.yapper.website/*"));
  assert.ok(!main.includes("https://*.yapin.gg/*"));
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

test("AppDir patch creates a backup and restore returns the exact original archive", async () => {
  const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { patchAppDir, restoreAppDir } = await import("../src/patcher.js");

  const appDir = mkdtempSync(join(tmpdir(), "yplusplus-boot-test-"));
  const resources = join(appDir, "resources");
  mkdirSync(resources, { recursive: true });
  const archivePath = join(resources, "app.asar");
  const original = makeYapperArchive();
  writeFileSync(archivePath, original);

  try {
    assert.equal(patchAppDir(appDir).status, "patched");
    assert.equal(patchAppDir(appDir).status, "already-patched");
    assert.notDeepEqual(readFileSync(archivePath), original);
    restoreAppDir(appDir);
    assert.deepEqual(readFileSync(archivePath), original);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("launch environment removes APPIMAGE to protect extracted AppRun from auto-updater replacement", async () => {
  const { buildLaunchEnvironment } = await import("../src/launcher.js");
  const env = buildLaunchEnvironment("/opt/yplusplus/yapper", {
    APPIMAGE: "/opt/yplusplus/yapper/AppRun",
    PATH: "/usr/bin",
    LD_LIBRARY_PATH: "/usr/lib",
    XDG_DATA_DIRS: "/usr/share"
  });
  assert.equal(env.APPIMAGE, undefined);
  assert.equal(env.APPDIR, "/opt/yplusplus/yapper");
  assert.ok(env.PATH?.startsWith("/opt/yplusplus/yapper:"));
  assert.ok(env.LD_LIBRARY_PATH?.startsWith("/opt/yplusplus/yapper/usr/lib:"));
});
