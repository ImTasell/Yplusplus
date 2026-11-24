import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { patchAppDir } from "../src/patcher.js";
import {
  checkYapperUpdate,
  compareVersions,
  downloadVerifiedAppImage,
  parseYapperUpdateManifest,
  updateYapper,
  type UpdateFetcher
} from "../src/updater.js";

const MAIN = Buffer.from([
  "const { app, session } = require('electron');",
  "const path = require('node:path');",
  "app.whenReady().then(() => {",
  "  const ses = session.defaultSession;",
  "});"
].join("\n"));
const PRELOAD = Buffer.from("original Yapper preload");

function makeManagedAppDir(root: string, version = "1.2.7"): string {
  const appDir = join(root, "managed-appdir");
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
  writeFileSync(join(resources, "app.asar"), encodeAsar(header, Buffer.concat([packageJson, MAIN, PRELOAD])));
  writeFileSync(join(resources, "app-update.yml"), [
    "provider: generic",
    "url: https://www.yapper.website/download",
    "updaterCacheDirName: yapper-desktop-updater",
    ""
  ].join("\n"));
  const executable = join(appDir, "yapper-desktop");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  patchAppDir(appDir);
  return appDir;
}

function manifest(version: string, fileUrl = "https://files.yapper.website/desktop/Yapper-Setup.AppImage", payload = Buffer.from("fake AppImage")): string {
  const sha512 = createHash("sha512").update(payload).digest("base64");
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${fileUrl}`,
    `    sha512: ${sha512}`,
    `    size: ${payload.length}`,
    "path: Yapper-Setup.AppImage",
    `sha512: ${sha512}`,
    ""
  ].join("\n");
}

function responseFetcher(body: string | Buffer, status = 200, headers: Record<string, string> = {}): UpdateFetcher {
  return async () => new Response(body, { status, headers });
}

test("compares stable and prerelease semantic versions correctly", () => {
  assert.equal(compareVersions("1.2.8", "1.2.7"), 1);
  assert.equal(compareVersions("1.2.7", "1.2.7"), 0);
  assert.equal(compareVersions("1.2.6", "1.2.7"), -1);
  assert.equal(compareVersions("1.2.7", "1.2.7-rc.1"), 1);
  assert.equal(compareVersions("1.2.7-rc.2", "1.2.7-rc.1"), 1);
  assert.throws(() => compareVersions("latest", "1.2.7"), /invalid semantic version/);
});

test("parses electron-updater Linux channel metadata and its AppImage checksum", () => {
  const payload = Buffer.from("fake AppImage");
  const parsed = parseYapperUpdateManifest(manifest("1.2.8", "Yapper-Setup.AppImage", payload));
  assert.equal(parsed.version, "1.2.8");
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0]?.url, "Yapper-Setup.AppImage");
  assert.equal(parsed.files[0]?.size, payload.length);
  assert.equal(parsed.files[0]?.sha512, createHash("sha512").update(payload).digest("base64"));
});

test("checks the exact Linux feed from app-update.yml and reports unsupported updates without downloading", async () => {
  const root = mkdtempSync(join(tmpdir(), "yplusplus-update-check-"));
  const appDir = makeManagedAppDir(root);
  const requested: string[] = [];
  const fetcher: UpdateFetcher = async (input) => {
    requested.push(String(input));
    return new Response(manifest("1.2.8"), { status: 200 });
  };

  try {
    const result = await checkYapperUpdate(appDir, fetcher);
    assert.deepEqual(requested, ["https://www.yapper.website/download/latest-linux.yml"]);
    assert.equal(result.currentVersion, "1.2.7");
    assert.equal(result.latestVersion, "1.2.8");
    assert.equal(result.available, true);
    assert.equal(result.compatible, false);
    assert.equal(result.file.url, "https://files.yapper.website/desktop/Yapper-Setup.AppImage");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not offer a downgrade or reinstall when the feed version matches", async () => {
  const root = mkdtempSync(join(tmpdir(), "yplusplus-update-current-"));
  const appDir = makeManagedAppDir(root);
  try {
    const result = await checkYapperUpdate(appDir, responseFetcher(manifest("1.2.7")));
    assert.equal(result.available, false);
    assert.equal(result.compatible, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects update manifests that point to untrusted download hosts", async () => {
  const root = mkdtempSync(join(tmpdir(), "yplusplus-update-host-"));
  const appDir = makeManagedAppDir(root);
  try {
    await assert.rejects(
      checkYapperUpdate(appDir, responseFetcher(manifest("1.2.8", "https://evil.example/Yapper.AppImage"))),
      /non-official or insecure/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects redirects away from official HTTPS hosts", async () => {
  const root = mkdtempSync(join(tmpdir(), "yplusplus-update-redirect-"));
  const appDir = makeManagedAppDir(root);
  let calls = 0;
  const fetcher: UpdateFetcher = async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "https://evil.example/manifest.yml" } });
  };
  try {
    await assert.rejects(checkYapperUpdate(appDir, fetcher), /non-official or insecure/);
    assert.equal(calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("downloads an AppImage as a stream and verifies its SHA-512 and exact size", async () => {
  const root = mkdtempSync(join(tmpdir(), "yplusplus-update-download-"));
  const payload = Buffer.from("a small fake AppImage payload");
  const file = {
    url: "https://files.yapper.website/desktop/Yapper-Setup.AppImage",
    sha512: createHash("sha512").update(payload).digest("base64"),
    size: payload.length
  };
  const destination = join(root, "download", "Yapper.AppImage");
  try {
    const result = await downloadVerifiedAppImage(
      file,
      destination,
      responseFetcher(payload, 200, { "content-length": String(payload.length) })
    );
    assert.equal(result.bytes, payload.length);
    assert.equal(result.sha512, file.sha512);
    assert.deepEqual(readFileSync(destination), payload);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discards an AppImage whose checksum does not match the manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "yplusplus-update-bad-hash-"));
  const payload = Buffer.from("tampered update");
  const file = {
    url: "https://files.yapper.website/desktop/Yapper-Setup.AppImage",
    sha512: createHash("sha512").update("different bytes").digest("base64"),
    size: payload.length
  };
  const destination = join(root, "Yapper.AppImage");
  try {
    await assert.rejects(
      downloadVerifiedAppImage(file, destination, responseFetcher(payload)),
      /SHA-512 verification failed/
    );
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to download an update that the current patcher cannot safely support", async () => {
  const root = mkdtempSync(join(tmpdir(), "yplusplus-update-unsupported-"));
  const appDir = makeManagedAppDir(root);
  let calls = 0;
  const fetcher: UpdateFetcher = async () => {
    calls++;
    return new Response(manifest("1.2.8"), { status: 200 });
  };
  try {
    await assert.rejects(updateYapper(appDir, fetcher), /only patches 1.2.7/);
    assert.equal(calls, 1, "only the small manifest should be requested");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("update command does not download when the installed version is current", async () => {
  const root = mkdtempSync(join(tmpdir(), "yplusplus-update-noop-"));
  const appDir = makeManagedAppDir(root);
  let calls = 0;
  const fetcher: UpdateFetcher = async () => {
    calls++;
    return new Response(manifest("1.2.7"), { status: 200 });
  };
  try {
    const result = await updateYapper(appDir, fetcher);
    assert.equal(result.status, "up-to-date");
    assert.equal(calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
