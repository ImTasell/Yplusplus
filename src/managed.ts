import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  readFileSync,
  statSync,
  writeFileSync,
  unlinkSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKUP_SUFFIX, inspectAppDir, patchAppDir } from "./patcher.js";

export const YPLUSPLUS_RUNTIME_VERSION = "0.1.6";

const RUNTIME_FILES = [
  "cli.js",
  "managed.js",
  "launcher.js",
  "patcher.js",
  "asar.js",
  "preload-source.js",
  "updater.js",
  "runtime/plugin-manager-service.js",
  "runtime/plugin-settings-page-ipc.js",
  "runtime/plugin-manager-window.js",
  "runtime/assets/plugin-manager.html",
  "runtime/assets/plugin-manager.css",
  "runtime/assets/plugin-manager-renderer.js",
  "runtime/assets/plugin-manager-preload.cjs",
  "runtime/assets/plugin-preload.cjs",
  "runtime/assets/plugin-host.html"
] as const;

export interface ManagedInstallOptions {
  dataHome?: string;
  applicationsDir?: string;
  nodeExecutable?: string;
  runtimeSourceDir?: string;
}

export interface ManagedInstallResult {
  status: "installed" | "already-installed";
  version: string;
  appDir: string;
  desktopFile: string;
  runtimeDir: string;
}

export function managedPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  const configuredDataHome = env.XDG_DATA_HOME;
  const dataHome = configuredDataHome && isAbsolute(configuredDataHome)
    ? resolve(configuredDataHome)
    : join(home, ".local", "share");

  return {
    dataHome,
    managedRoot: join(dataHome, "yplusplus"),
    versionsDir: join(dataHome, "yplusplus", "versions"),
    runtimeParent: join(dataHome, "yplusplus", "runtime"),
    applicationsDir: join(dataHome, "applications")
  };
}

export function quoteDesktopArg(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(/%/g, "%%");
  return `"${escaped}"`;
}

function escapeDesktopValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "");
}

export function renderDesktopEntry(nodeExecutable: string, cliPath: string, appDir: string): string {
  const exec = [nodeExecutable, cliPath, "launch", appDir].map(quoteDesktopArg).join(" ");
  const managerExec = [nodeExecutable, cliPath, "launch", appDir, "--yplusplus-plugin-manager"].map(quoteDesktopArg).join(" ");
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=Yapin' (Y++)",
    "Comment=Yapin' desktop launched and managed by Y++",
    `Exec=${exec}`,
    `Path=${escapeDesktopValue(appDir)}`,
    "Icon=applications-internet",
    "Terminal=false",
    "StartupNotify=true",
    "DBusActivatable=false",
    "Categories=Network;InstantMessaging;",
    "StartupWMClass=Yapin",
    "Actions=PluginManager;",
    "",
    "[Desktop Action PluginManager]",
    "Name=Plugin Manager",
    "Comment=Manage Y++ plugins and permissions",
    `Exec=${managerExec}`,
    ""
  ].join("\n");
}

function writeFileAtomically(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const stagingDir = mkdtempSync(join(dirname(filePath), ".yplusplus-write-"));
  const stagingFile = join(stagingDir, "new-file");
  try {
    writeFileSync(stagingFile, contents, { mode: 0o644, flag: "wx" });
    renameSync(stagingFile, filePath);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function installRuntime(runtimeParent: string, runtimeSourceDir: string): string {
  const runtimeDir = join(runtimeParent, YPLUSPLUS_RUNTIME_VERSION);
  mkdirSync(runtimeParent, { recursive: true });

  if (existsSync(runtimeDir)) {
    const runtimeStat = lstatSync(runtimeDir);
    if (runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory()) {
      throw new Error("Managed Y++ runtime path is not a regular directory.");
    }
    for (const file of [...RUNTIME_FILES, "runtime/bootstrap.js", "package.json"]) {
      const runtimeFile = join(runtimeDir, file);
      if (!existsSync(runtimeFile) || lstatSync(runtimeFile).isSymbolicLink() || !lstatSync(runtimeFile).isFile()) {
        throw new Error(`Managed Y++ runtime is incomplete or unsafe: ${runtimeFile}.`);
      }
    }
    return runtimeDir;
  }

  for (const file of [...RUNTIME_FILES, "runtime/bootstrap.js"]) {
    if (!existsSync(join(runtimeSourceDir, file))) {
      throw new Error(
        `Built Y++ runtime file ${join(runtimeSourceDir, file)} is missing. Run npm run build before installing.`
      );
    }
  }

  const stagingDir = mkdtempSync(join(runtimeParent, `.yplusplus-${YPLUSPLUS_RUNTIME_VERSION}-`));
  try {
    // tsc's rootDir is the repository root, so executable modules live in
    // dist/src. Copy that directory's contents as the managed runtime root.
    cpSync(runtimeSourceDir, stagingDir, { recursive: true, dereference: false });
    writeFileSync(
      join(stagingDir, "package.json"),
      JSON.stringify({
        name: "@yplusplus/managed-runtime",
        version: YPLUSPLUS_RUNTIME_VERSION,
        private: true,
        type: "module"
      }, null, 2) + "\n",
      { flag: "wx", mode: 0o644 }
    );
    renameSync(stagingDir, runtimeDir);
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }

  return runtimeDir;
}

export function installExtractedAppDir(
  extractedAppDir: string,
  options: ManagedInstallOptions = {}
): ManagedInstallResult {
  const paths = managedPaths();
  const dataHome = resolve(options.dataHome ?? paths.dataHome);
  const managedRoot = join(dataHome, "yplusplus");
  const versionsDir = join(managedRoot, "versions");
  const runtimeParent = join(managedRoot, "runtime");
  const applicationsDir = resolve(options.applicationsDir ?? join(dataHome, "applications"));
  const nodeExecutable = resolve(options.nodeExecutable ?? process.execPath);
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  // When running from dist/src/managed.js, moduleDir is the compiled source root.
  const runtimeSourceDir = resolve(options.runtimeSourceDir ?? moduleDir);

  const sourceAppDir = resolve(extractedAppDir);
  if (!existsSync(sourceAppDir) || !lstatSync(sourceAppDir).isDirectory() || lstatSync(sourceAppDir).isSymbolicLink()) {
    throw new Error(`Extracted AppDir is not a regular directory: ${sourceAppDir}`);
  }

  const inspected = inspectAppDir(sourceAppDir);
  if (inspected.name !== "yapper-desktop") {
    throw new Error(`This does not look like Yapper Desktop (package name: ${inspected.name}).`);
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(inspected.version)) {
    throw new Error(`Yapper version cannot be used as a managed directory name: ${inspected.version}`);
  }

  mkdirSync(versionsDir, { recursive: true });
  const appDir = join(versionsDir, `yapper-desktop-${inspected.version}`);
  let status: ManagedInstallResult["status"];

  if (existsSync(appDir)) {
    if (lstatSync(appDir).isSymbolicLink() || !lstatSync(appDir).isDirectory()) {
      throw new Error(`Managed install target is not a regular directory: ${appDir}`);
    }
    const existing = inspectAppDir(appDir);
    if (existing.name !== inspected.name || existing.version !== inspected.version) {
      throw new Error(`Managed install target already exists with unexpected metadata: ${appDir}`);
    }
    patchAppDir(appDir);
    const backupPath = existing.archivePath + BACKUP_SUFFIX;
    if (!existsSync(backupPath)) {
      throw new Error("Existing managed installation has no clean Y++ backup; refusing to adopt it.");
    }
    const previousOriginal = readFileSync(backupPath);
    const incomingOriginal = readFileSync(join(sourceAppDir, "resources", "app.asar"));
    if (!previousOriginal.equals(incomingOriginal)) {
      throw new Error("A different ASAR payload uses this Yapper version number; refusing to replace or silently reuse it.");
    }
    status = "already-installed";
  } else {
    patchAppDir(sourceAppDir);
    renameSync(sourceAppDir, appDir);
    status = "installed";
  }

  const runtimeDir = installRuntime(runtimeParent, runtimeSourceDir);
  const cliPath = join(runtimeDir, "cli.js");
  const desktopFile = join(applicationsDir, "yplusplus-yapin.desktop");
  writeFileAtomically(desktopFile, renderDesktopEntry(nodeExecutable, cliPath, appDir));
  const legacyDesktopFile = join(applicationsDir, "yplusplus-yapper.desktop");
  if (existsSync(legacyDesktopFile)) {
    const legacyContents = readFileSync(legacyDesktopFile, "utf8");
    if (legacyContents.includes("Name=Yapper (Y++)") && legacyContents.includes("yplusplus")) {
      unlinkSync(legacyDesktopFile);
    }
  }

  return { status, version: inspected.version, appDir, desktopFile, runtimeDir };
}

export function installAppImage(
  appImagePath: string,
  options: ManagedInstallOptions = {}
): ManagedInstallResult {
  const source = resolve(appImagePath);
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`AppImage file does not exist: ${source}`);
  }
  if ((statSync(source).mode & 0o111) === 0) {
    throw new Error(`AppImage is not executable: ${source}. Run chmod +x on the file and retry.`);
  }

  const paths = managedPaths();
  const dataHome = resolve(options.dataHome ?? paths.dataHome);
  const versionsDir = join(dataHome, "yplusplus", "versions");
  mkdirSync(versionsDir, { recursive: true });
  const stagingDir = mkdtempSync(join(versionsDir, ".yplusplus-extract-"));

  try {
    execFileSync(source, ["--appimage-extract"], {
      cwd: stagingDir,
      stdio: "inherit",
      timeout: 300_000
    });

    const extractedAppDir = join(stagingDir, "squashfs-root");
    if (!existsSync(extractedAppDir) || !lstatSync(extractedAppDir).isDirectory()) {
      throw new Error("AppImage extraction completed but did not produce a squashfs-root AppDir.");
    }
    return installExtractedAppDir(extractedAppDir, options);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
