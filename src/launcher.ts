import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { inspectAppDir } from "./patcher.js";
import { managedPaths, YPLUSPLUS_RUNTIME_VERSION } from "./managed.js";

export function buildLaunchEnvironment(appDir: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const root = resolve(appDir);
  const env: NodeJS.ProcessEnv = { ...inherited };

  // AppRun normally sets APPIMAGE to itself when launched from an extracted AppDir.
  // electron-updater's AppImageUpdater unlinks APPIMAGE during installation, so never
  // let it mistake AppRun (or any other wrapper) for a replaceable AppImage.
  delete env.APPIMAGE;

  env.APPDIR = root;
  const paths = managedPaths(inherited);
  const runtimeDir = join(paths.runtimeParent, YPLUSPLUS_RUNTIME_VERSION);
  env.YPLUSPLUS_RUNTIME_ENTRY = join(runtimeDir, "runtime", "bootstrap.js");
  env.YPLUSPLUS_PLUGIN_DIR = join(paths.managedRoot, "plugins");
  env.PATH = [root, join(root, "usr", "sbin"), inherited.PATH].filter(Boolean).join(delimiter);
  env.XDG_DATA_DIRS = [
    join(root, "usr", "share"),
    inherited.XDG_DATA_DIRS,
    "/usr/share/gnome",
    "/usr/local/share/",
    "/usr/share/"
  ].filter(Boolean).join(":");
  env.LD_LIBRARY_PATH = [join(root, "usr", "lib"), inherited.LD_LIBRARY_PATH].filter(Boolean).join(":");
  env.GSETTINGS_SCHEMA_DIR = join(root, "usr", "share", "glib-2.0", "schemas");

  return env;
}

export function launchAppDir(appDir: string, args: string[] = []): void {
  const inspected = inspectAppDir(appDir);
  if (!inspected.patched) {
    throw new Error("Yapper AppDir is not patched. Run the Y++ patch command before launching.");
  }

  const root = resolve(appDir);
  const executable = join(root, "yapper-desktop");
  if (!existsSync(executable)) {
    throw new Error(`Yapper Electron executable was not found at ${executable}.`);
  }

  const env = buildLaunchEnvironment(root);
  const namespaceProbe = spawnSync("unshare", ["-Ur", "true"], { stdio: "ignore", timeout: 5000 });
  const launchArgs = [...args];

  // Match the official AppRun fallback when user namespaces are unavailable.
  if (namespaceProbe.error || namespaceProbe.status !== 0) {
    if (!launchArgs.includes("--no-sandbox")) launchArgs.unshift("--no-sandbox");
  }

  const child = spawn(executable, launchArgs, {
    cwd: root,
    env,
    stdio: "inherit"
  });

  child.once("error", (error) => {
    console.error("[Y++] Could not start Yapper:", error);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    if (signal) {
      console.error(`[Y++] Yapper exited after signal ${signal}.`);
      process.exitCode = 1;
    } else {
      process.exitCode = code ?? 1;
    }
  });
}
