import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { inspectAppDir, patchAppDir, restoreAppDir } from "./patcher.js";
import { launchAppDir } from "./launcher.js";
import { installAppImage } from "./managed.js";

function usage(): never {
  console.error(`Y++ BOOT 0.1.0

Usage:
  yplusplus inspect <extracted-appdir>
  yplusplus patch <extracted-appdir>
  yplusplus restore <extracted-appdir>
  yplusplus launch <patched-appdir> [electron-args...]

The AppDir must be extracted from the official Yapper Linux AppImage first.
Y++ never modifies the original AppImage.
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
    default:
      usage();
  }
} catch (error) {
  console.error("Y++ BOOT failed safely:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
