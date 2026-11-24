import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PluginApprovalController } from "./plugins/approval-controller.js";
import { discoverPlugins } from "./plugins/discovery.js";
import { inspectAppDir, patchAppDir, restoreAppDir } from "./patcher.js";
import { launchAppDir } from "./launcher.js";
import { installAppImage } from "./managed.js";
import { checkYapperUpdate, updateYapper } from "./updater.js";


async function managePlugins(action: string | undefined, args: string[]): Promise<void> {
  const configuredDataHome = process.env.XDG_DATA_HOME;
  const dataHome = configuredDataHome && isAbsolute(configuredDataHome)
    ? resolve(configuredDataHome)
    : join(homedir(), ".local", "share");
  const configuredRoot = process.env.YPLUSPLUS_PLUGIN_DIR;
  const pluginRoot = configuredRoot && isAbsolute(configuredRoot)
    ? resolve(configuredRoot)
    : join(dataHome, "yplusplus", "plugins");
  const discovery = await discoverPlugins(pluginRoot);
  const controller = new PluginApprovalController();

  if (action === "list") {
    const report = await controller.inspect(discovery);
    for (const plugin of report.plugins) {
      console.log(`${plugin.id}@${plugin.version}  ${plugin.state}  trusted=${plugin.trusted ? "yes" : "no"}  permissions=${plugin.approvedPermissions.join(",") || "none"}`);
    }
    for (const rejected of report.rejected) {
      console.warn(`Rejected ${rejected.directory}: ${rejected.issues.map((issue) => issue.code).join(", ")}`);
    }
    if (report.plugins.length === 0 && report.rejected.length === 0) console.log("No plugins discovered.");
    return;
  }

  const [pluginId, pluginVersion, ...values] = args;
  if (!pluginId || (action !== "untrust-all" && !pluginVersion)) {
    throw new Error("A plugin ID and exact version are required for this action.");
  }
  const plugin = discovery.plugins.find((item) =>
    item.manifest.id === pluginId && (action === "untrust-all" || item.manifest.version === pluginVersion));
  if (action !== "untrust-all" && !plugin) {
    throw new Error(`No discovered plugin matches ${pluginId}@${pluginVersion}.`);
  }

  switch (action) {
    case "trust":
      await controller.trust(plugin!);
      console.log(`Trusted ${pluginId}@${pluginVersion}. Capability permissions were not granted.`);
      break;
    case "untrust":
      await controller.untrust(pluginId, pluginVersion!);
      console.log(`Revoked execution trust for ${pluginId}@${pluginVersion}.`);
      break;
    case "untrust-all":
      await controller.untrustPlugin(pluginId);
      console.log(`Revoked execution trust for every release of ${pluginId}.`);
      break;
    case "approve":
      await controller.approve(plugin!, values);
      console.log(`Approved capabilities for ${pluginId}@${pluginVersion}: ${values.join(", ")}`);
      break;
    case "revoke":
      await controller.revoke(pluginId, pluginVersion!, values.length ? values : undefined);
      console.log(`Revoked capability grants for ${pluginId}@${pluginVersion}.`);
      break;
    default:
      throw new Error("Unknown plugins action. Use list, trust, untrust, untrust-all, approve, or revoke.");
  }
}
\nfunction usage(): never {
  console.error(`Y++ BOOT 0.1.0

Usage:
  yplusplus inspect <extracted-appdir>
  yplusplus patch <extracted-appdir>
  yplusplus restore <extracted-appdir>
  yplusplus launch <patched-appdir> [electron-args...]
  yplusplus install <Yapper.AppImage>
  yplusplus check-updates <managed-appdir>
  yplusplus update <managed-appdir>
  yplusplus plugins list
  yplusplus plugins trust <plugin-id> <version>
  yplusplus plugins untrust <plugin-id> <version>
  yplusplus plugins untrust-all <plugin-id>
  yplusplus plugins approve <plugin-id> <version> <capability...>
  yplusplus plugins revoke <plugin-id> <version> [capability...]

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
\n}\n