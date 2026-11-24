import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { encodeAsar, getRootFile, makeIntegrity, parseAsar, readAsarFile, type AsarFileEntry } from "./asar.js";

export const SUPPORTED_YAPPER_VERSION = "1.2.7";
export const PATCH_MARKER = "/* Y++ BOOTSTRAP: BEGIN */";
export const PRELOAD_FILENAME = "yplusplus-preload.cjs";
export const BACKUP_SUFFIX = ".yplusplus-original";

const TARGET_PACKAGE_NAME = "yapper-desktop";
const MAIN_ANCHOR = "  const ses = session.defaultSession;";

export interface PatchResult {
  status: "patched" | "already-patched";
  version: string;
  archivePath: string;
  backupPath: string;
}

function preloadSource(): Buffer {
  // The checked-in preload is deliberately self-contained and uses only Electron's sandbox preload API.
  // The build step emits this same source as a standalone CommonJS preload bundle.
  const source = [
    '"use strict";',
    'const { contextBridge } = require("electron");',
    'const ALLOWED_HOSTS = new Set(["www.yapper.website", "yapper.website", "www.yapin.gg", "yapin.gg"]);',
    'const VERSION = "0.1.0";',
    'try {',
    '  const currentUrl = new URL(globalThis.location.href);',
    '  const allowed = currentUrl.protocol === "https:" && ALLOWED_HOSTS.has(currentUrl.hostname);',
    '  if (process.isMainFrame && allowed) {',
    '    contextBridge.exposeInMainWorld("yplusplus", {',
    '      version: VERSION,',
    '      runtime: "yapper-desktop",',
    '      ready: true,',
    '      getStatus: () => ({ ready: true, version: VERSION, origin: currentUrl.origin })',
    '    });',
    '  }',
    '} catch (error) {',
    '  console.error("[Y++] Preload initialization failed:", error);',
    '}',
    ""
  ].join("\n");
  return Buffer.from(source, "utf8");
}

function getPackageMetadata(archiveBuffer: Buffer): { name?: string; version?: string } {
  const parsed = parseAsar(archiveBuffer);
  const packageJson = JSON.parse(readAsarFile(parsed, "package.json").toString("utf8")) as {
    name?: string;
    version?: string;
  };
  return packageJson;
}

function makeRegistrationSnippet(): string {
  return [
    "  " + PATCH_MARKER,
    "  try {",
    "    if (typeof ses.registerPreloadScript !== 'function') {",
    "      throw new Error('Electron session.registerPreloadScript is unavailable');",
    "    }",
    "    ses.registerPreloadScript({",
    "      type: 'frame',",
    "      id: 'yplusplus-runtime',",
    "      filePath: path.join(__dirname, 'yplusplus-preload.cjs'),",
    "      matches: [",
    "        'https://www.yapper.website/*',",
    "        'https://yapper.website/*',",
    "        'https://www.yapin.gg/*',",
    "        'https://yapin.gg/*'",
    "      ]",
    "    });",
    "    console.info('[Y++] Additional preload registered');",
    "  } catch (error) {",
    "    console.error('[Y++] Preload registration failed; continuing without Y++:', error);",
    "  }",
    "  /* Y++ BOOTSTRAP: END */"
  ].join("\n");
}

export function patchAsarBuffer(archiveBuffer: Buffer): { buffer: Buffer; status: PatchResult["status"]; version: string } {
  const parsed = parseAsar(archiveBuffer);
  const metadata = JSON.parse(readAsarFile(parsed, "package.json").toString("utf8")) as {
    name?: string;
    version?: string;
  };

  if (metadata.name !== TARGET_PACKAGE_NAME) {
    throw new Error(`Unsupported application package "${metadata.name ?? "unknown"}"; expected "${TARGET_PACKAGE_NAME}".`);
  }

  if (metadata.version !== SUPPORTED_YAPPER_VERSION) {
    throw new Error(`Unsupported Yapper version "${metadata.version ?? "unknown"}"; this patch only supports ${SUPPORTED_YAPPER_VERSION}.`);
  }

  const mainEntry = getRootFile(parsed.header, "main.js");
  const mainSource = readAsarFile(parsed, "main.js").toString("utf8");

  if (mainSource.includes(PATCH_MARKER)) {
    if (!parsed.header.files[PRELOAD_FILENAME]) {
      throw new Error("Archive contains a Y++ patch marker but the Y++ preload entry is missing.");
    }
    readAsarFile(parsed, PRELOAD_FILENAME);
    return { buffer: archiveBuffer, status: "already-patched", version: metadata.version };
  }

  if (parsed.header.files[PRELOAD_FILENAME]) {
    throw new Error(`Archive already contains "${PRELOAD_FILENAME}" without a recognized Y++ patch marker; refusing to overwrite it.`);
  }

  const anchorOccurrences = mainSource.split(MAIN_ANCHOR).length - 1;
  if (anchorOccurrences !== 1) {
    throw new Error(`Yapper main-process anchor mismatch: expected exactly one occurrence, found ${anchorOccurrences}. No changes were made.`);
  }

  const patchedMain = Buffer.from(
    mainSource.replace(MAIN_ANCHOR, `${MAIN_ANCHOR}\n${makeRegistrationSnippet()}`),
    "utf8"
  );
  const preload = preloadSource();

  const newHeader = structuredClone(parsed.header);
  const newMainEntry = getRootFile(newHeader, "main.js") as AsarFileEntry;
  const newMainOffset = parsed.data.length;
  newMainEntry.size = patchedMain.length;
  newMainEntry.offset = String(newMainOffset);
  newMainEntry.integrity = makeIntegrity(patchedMain);

  const newPreloadOffset = newMainOffset + patchedMain.length;
  newHeader.files[PRELOAD_FILENAME] = {
    size: preload.length,
    offset: String(newPreloadOffset),
    integrity: makeIntegrity(preload)
  };

  const newData = Buffer.concat([parsed.data, patchedMain, preload]);
  return {
    buffer: encodeAsar(newHeader, newData),
    status: "patched",
    version: metadata.version
  };
}

export function inspectAppDir(appDir: string): { appDir: string; archivePath: string; name: string; version: string; mainAnchorCount: number; patched: boolean } {
  const resolvedAppDir = resolve(appDir);
  const archivePath = join(resolvedAppDir, "resources", "app.asar");
  if (!existsSync(archivePath)) {
    throw new Error(`No resources/app.asar found under ${resolvedAppDir}.`);
  }

  const archive = parseAsar(readFileSync(archivePath));
  const metadata = JSON.parse(readAsarFile(archive, "package.json").toString("utf8")) as {
    name?: string;
    version?: string;
  };
  const mainSource = readAsarFile(archive, "main.js").toString("utf8");

  return {
    appDir: resolvedAppDir,
    archivePath,
    name: metadata.name ?? "unknown",
    version: metadata.version ?? "unknown",
    mainAnchorCount: mainSource.split(MAIN_ANCHOR).length - 1,
    patched: mainSource.includes(PATCH_MARKER)
  };
}

export function patchAppDir(appDir: string): PatchResult {
  const inspected = inspectAppDir(appDir);
  if (inspected.name !== TARGET_PACKAGE_NAME) {
    throw new Error(`This does not look like Yapper Desktop (package name: ${inspected.name}).`);
  }
  if (inspected.version !== SUPPORTED_YAPPER_VERSION) {
    throw new Error(`Unsupported Yapper version ${inspected.version}; supported version: ${SUPPORTED_YAPPER_VERSION}.`);
  }

  const archivePath = inspected.archivePath;
  const backupPath = archivePath + BACKUP_SUFFIX;
  const original = readFileSync(archivePath);
  const result = patchAsarBuffer(original);

  if (result.status === "already-patched") {
    return { status: result.status, version: result.version, archivePath, backupPath };
  }

  if (!existsSync(backupPath)) {
    copyFileSync(archivePath, backupPath);
  }

  const temporaryPath = archivePath + ".yplusplus-tmp";
  try {
    writeFileSync(temporaryPath, result.buffer, { flag: "wx" });
    renameSync(temporaryPath, archivePath);
  } catch (error) {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
    throw error;
  }

  return { status: result.status, version: result.version, archivePath, backupPath };
}

export function restoreAppDir(appDir: string): string {
  const archivePath = join(resolve(appDir), "resources", "app.asar");
  const backupPath = archivePath + BACKUP_SUFFIX;
  if (!existsSync(backupPath)) {
    throw new Error(`No Y++ backup found at ${backupPath}.`);
  }

  const temporaryPath = archivePath + ".yplusplus-restore-tmp";
  copyFileSync(backupPath, temporaryPath);
  renameSync(temporaryPath, archivePath);
  return archivePath;
}
