import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { encodeAsar, getRootFile, makeIntegrity, parseAsar, readAsarFile, type AsarFileEntry } from "./asar.js";
import { YPLUSPLUS_PRELOAD_SOURCE } from "./preload-source.js";

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
  return Buffer.from(YPLUSPLUS_PRELOAD_SOURCE, "utf8");
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
    "  try {",
    "    const runtimeEntry = process.env.YPLUSPLUS_RUNTIME_ENTRY;",
    "    if (runtimeEntry) {",
    "      import(require('node:url').pathToFileURL(runtimeEntry).href)",
    "        .then((runtime) => runtime.startYplusplusMain({ app, BrowserWindow, ipcMain, MessageChannelMain: require('electron').MessageChannelMain, Notification }))",
    "        .catch((error) => console.error('[Y++] Main-process integration failed safely:', error));",
    "    } else {",
    "      console.warn('[Y++] Managed runtime path is not configured; plugin runtime is disabled.');",
    "    }",
    "  } catch (error) {",
    "    console.error('[Y++] Main-process integration could not start:', error);",
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

  const mainSource = readAsarFile(parsed, "main.js").toString("utf8");

  if (mainSource.includes(PATCH_MARKER)) {
    if (!parsed.header.files[PRELOAD_FILENAME]) {
      throw new Error("Archive contains a Y++ patch marker but the Y++ preload entry is missing.");
    }
    const existingPreload = readAsarFile(parsed, PRELOAD_FILENAME);
    if (!existingPreload.equals(preloadSource()) || !mainSource.includes("/* Y++ BOOTSTRAP: END */")) {
      throw new Error("Archive contains a Y++ marker but its preload or closing marker does not match this bootstrap version.");
    }
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
  } else {
    const backupArchive = parseAsar(readFileSync(backupPath));
    const backupPackage = JSON.parse(readAsarFile(backupArchive, "package.json").toString("utf8")) as {
      name?: string;
      version?: string;
    };
    const backupMain = readAsarFile(backupArchive, "main.js").toString("utf8");
    if (backupPackage.name !== TARGET_PACKAGE_NAME || backupPackage.version !== inspected.version || backupMain.includes(PATCH_MARKER)) {
      throw new Error("Existing Y++ backup is not a clean original for this Yapper version; refusing to overwrite it.");
    }
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
  const inspected = inspectAppDir(appDir);
  const archivePath = inspected.archivePath;
  const backupPath = archivePath + BACKUP_SUFFIX;
  if (!existsSync(backupPath)) {
    throw new Error(`No Y++ backup found at ${backupPath}.`);
  }
  if (!inspected.patched) {
    throw new Error("Current archive does not contain a recognized Y++ patch; refusing to replace it.");
  }

  const backupArchive = parseAsar(readFileSync(backupPath));
  const backupPackage = JSON.parse(readAsarFile(backupArchive, "package.json").toString("utf8")) as {
    name?: string;
    version?: string;
  };
  const backupMain = readAsarFile(backupArchive, "main.js").toString("utf8");
  if (backupPackage.name !== TARGET_PACKAGE_NAME || backupPackage.version !== inspected.version || backupMain.includes(PATCH_MARKER)) {
    throw new Error("Y++ backup does not match the current Yapper version or is already patched; refusing to restore.");
  }

  const temporaryPath = archivePath + ".yplusplus-restore-tmp";
  copyFileSync(backupPath, temporaryPath);
  renameSync(temporaryPath, archivePath);
  return archivePath;
}
