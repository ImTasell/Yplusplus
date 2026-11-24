import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { inspectAppDir, patchAppDir, restoreAppDir } from "./patcher.js";
import { launchAppDir } from "./launcher.js";
import { installAppImage } from "./managed.js";
import { checkYapperUpdate, updateYapper } from "./updater.js";

function usage(): never {
  console.error(`Y++ BOOT 0.1.0

Usage:
  yplusplus inspect <extracted-appdir>
  yplusplus patch <extracted-appdir>
  yplusplus restore <extracted-appdir>
  yplusplus launch <patched-appdir> [electron-args...]
  yplusplus install <Yapper.AppImage>
  yplusplus check-updates <managed-appdir>
  yplusplus update <managed-appdir>

The AppDir must be extracted from the official Yapper Linux AppImage first.
Y++ never modifies the original AppImage.
The install command creates a versioned managed AppDir and desktop entry.
Update checks use Yapper's official HTTPS feed; downloads require an explicit update command.
`);
  process.exit(2);
}

const [command, target] = process.argv.slice(2);
if (!command || !target) usage();

const appDir = resolve(target);
if (!existsSync(appDir)) {
  console.error(`Path does not exist: ${appDir}`);
  process.exit(1);
}

try {
  switch (command) {
    case "inspect": {
      const result = inspectAppDir(appDir);
      console.log("Y++ BOOT target inspection");
      console.log(`  AppDir: ${result.appDir}`);
      console.log(`  Package: ${result.name}`);
      console.log(`  Version: ${result.version}`);
      console.log(`  Main-process anchor matches: ${result.mainAnchorCount}`);
      console.log(`  Y++ patch present: ${result.patched ? "yes" : "no"}`);
      console.log(`  Archive: ${result.archivePath}`);
      break;
    }
    case "patch": {
      const result = patchAppDir(appDir);
      console.log(`Y++ BOOT: ${result.status}`);
      console.log(`  Yapper: ${result.version}`);
      console.log(`  Patched archive: ${result.archivePath}`);
      console.log(`  Original backup: ${result.backupPath}`);
      break;
    }
    case "restore": {
      console.log(`Restored original archive: ${restoreAppDir(appDir)}`);
      break;
    }
    case "launch": {
      launchAppDir(appDir, process.argv.slice(4));
      break;
    }
    case "install": {
      const result = installAppImage(appDir);
      console.log("Y++ managed install: " + result.status);
      console.log("  Yapper: " + result.version);
      console.log("  AppDir: " + result.appDir);
      console.log("  Desktop entry: " + result.desktopFile);
      console.log("  Runtime: " + result.runtimeDir);
      break;
    }
    case "check-updates": {
      const result = await checkYapperUpdate(appDir);
      console.log("Y++ update check");
      console.log("  Installed: " + result.currentVersion);
      console.log("  Latest: " + result.latestVersion);
      console.log("  Update available: " + (result.available ? "yes" : "no"));
      console.log("  Supported by this Y++ build: " + (result.compatible ? "yes" : "no"));
      console.log("  Manifest: " + result.manifestUrl);
      if (result.available && !result.compatible) {
        console.warn("  Y++ will not download or install this version until its patch is verified.");
      }
      break;
    }
    case "update": {
      const result = await updateYapper(appDir);
      if (result.status === "up-to-date") {
        console.log("Yapper is up to date (" + result.check.currentVersion + ").");
      } else {
        console.log("Y++ installed Yapper " + result.install.version + ".");
        console.log("  AppDir: " + result.install.appDir);
        console.log("  Desktop entry: " + result.install.desktopFile);
        console.log("  The new version will be used the next time Yapper is launched.");
      }
      break;
    }
    default:
      usage();
  }
} catch (error) {
  console.error("Y++ BOOT failed safely:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
