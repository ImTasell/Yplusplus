import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAsar, makeIntegrity } from "../src/asar.js";
import { inspectAppDir } from "../src/patcher.js";
import {
  installExtractedAppDir,
  managedPaths,
  quoteDesktopArg,
  renderDesktopEntry
} from "../src/managed.js";

const MAIN = Buffer.from([
  "const { app, session } = require('electron');",
  "const path = require('node:path');",
  "app.whenReady().then(() => {",
  "  const ses = session.defaultSession;",
  "});"
].join("\n"));
const PRELOAD = Buffer.from("original Yapper preload");

function makeAppDir(appDir: string, version = "1.2.7"): void {
  const resources = join(appDir, "resources");
  mkdirSync(resources, { recursive: true });
  const packageJson = Buffer.from(JSON.stringify({ name: "yapper-desktop", version }));
  const header = {
    files: {
      "package.json": {
        size: packageJson.length,
        offset: "0",
        integrity: makeIntegrity(packageJson)
      },
      "main.js": {
        size: MAIN.length,
        offset: String(packageJson.length),
        integrity: makeIntegrity(MAIN)
      },
      "preload.js": {
        size: PRELOAD.length,
        offset: String(packageJson.length + MAIN.length),
        integrity: makeIntegrity(PRELOAD)
      }
    }
  };
  writeFileSync(
    join(resources, "app.asar"),
    encodeAsar(header, Buffer.concat([packageJson, MAIN, PRELOAD]))
  );
  const executable = join(appDir, "yapper-desktop");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
}

function makeRuntimeSource(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const file of [
    "cli.js",
    "managed.js",
    "launcher.js",
    "patcher.js",
    "asar.js",
    "preload-source.js"
  ]) {
    writeFileSync(join(dir, file), "// runtime fixture\n");
  }
}

test("managed paths follow XDG_DATA_HOME and fall back to the user data directory", () => {
  assert.equal(
    managedPaths({ XDG_DATA_HOME: "/mnt/data/user-data" }, "/home/test").managedRoot,
    "/mnt/data/user-data/yplusplus"
  );
  assert.equal(
    managedPaths({ XDG_DATA_HOME: "relative/path" }, "/home/test").dataHome,
    "/home/test/.local/share"
  );
});

test("desktop entry safely quotes executable and managed paths", () => {
  const entry = renderDesktopEntry(
    "/home/test/.nvm/bin/node",
    "/home/test/.local/share/yplusplus/runtime/0.1.0/cli.js",
    "/home/test/.local/share/yplusplus/versions/Yapper App"
  );
  assert.ok(entry.includes('Exec="/home/test/.nvm/bin/node"'));
  assert.ok(entry.includes('" /home/test'));
  assert.ok(entry.includes('"launch"'));
  assert.ok(entry.includes('" /home/test/.local/share/yplusplus/versions/Yapper App"') === false);
  assert.ok(entry.includes('"/home/test/.local/share/yplusplus/versions/Yapper App"'));
  assert.equal(quoteDesktopArg('/tmp/a "quoted" path'), '"/tmp/a \\"quoted\\" path"');
});

test("managed install patches atomically, installs its runtime and desktop entry, and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "yplusplus-managed-test-"));
  const extracted = join(root, "squashfs-root");
  const secondExtracted = join(root, "second-squashfs-root");
  const runtimeSource = join(root, "dist");
  const dataHome = join(root, "user data", ".local", "share");
  const nodeExecutable = "/usr/bin/node";
  mkdirSync(extracted, { recursive: true });
  mkdirSync(secondExtracted, { recursive: true });
  makeAppDir(extracted);
  makeAppDir(secondExtracted);
  makeRuntimeSource(runtimeSource);

  try {
    const first = installExtractedAppDir(extracted, {
      dataHome,
      nodeExecutable,
      runtimeSourceDir: runtimeSource
    });

    assert.equal(first.status, "installed");
    assert.equal(first.version, "1.2.7");
    assert.equal(existsSync(extracted), false, "the extracted AppDir should be moved into the managed store");
    assert.equal(inspectAppDir(first.appDir).patched, true);
    assert.equal(existsSync(first.appDir + "/resources/app.asar.yplusplus-original"), true);
    assert.equal(existsSync(join(first.runtimeDir, "cli.js")), true);
    assert.equal(JSON.parse(readFileSync(join(first.runtimeDir, "package.json"), "utf8")).type, "module");

    const desktop = readFileSync(first.desktopFile, "utf8");
    assert.ok(desktop.includes('Exec="/usr/bin/node"'));
    assert.ok(desktop.includes('"launch"'));
    assert.ok(desktop.includes(`"${first.appDir}"`));

    const installedArchive = readFileSync(join(first.appDir, "resources", "app.asar"));
    const second = installExtractedAppDir(secondExtracted, {
      dataHome,
      nodeExecutable,
      runtimeSourceDir: runtimeSource
    });
    assert.equal(second.status, "already-installed");
    assert.equal(second.appDir, first.appDir);
    assert.deepEqual(readFileSync(join(second.appDir, "resources", "app.asar")), installedArchive);
    assert.equal(inspectAppDir(second.appDir).patched, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed install refuses unsupported Yapper versions without moving the source AppDir", () => {
  const root = mkdtempSync(join(tmpdir(), "yplusplus-managed-unsupported-"));
  const extracted = join(root, "squashfs-root");
  mkdirSync(extracted, { recursive: true });
  makeAppDir(extracted, "1.2.8");

  try {
    assert.throws(
      () => installExtractedAppDir(extracted, {
        dataHome: join(root, "data"),
        runtimeSourceDir: join(root, "missing-dist")
      }),
      /only supports 1.2.7/
    );
    assert.equal(existsSync(extracted), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
