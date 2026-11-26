/**
 * Y++ main-process bootstrap for the managed Yapper installation.
 *
 * This module is dynamically imported by the version-specific BOOT patch.
 * It owns discovery, trust, approvals, runtime startup, and manager UI.
 */
import { cp, lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginApprovalController } from "../plugins/approval-controller.js";
import { PluginSettingsStore } from "../plugins/plugin-settings-store.js";
import { PluginEnabledStore } from "../plugins/plugin-enabled-store.js";
import { FontStore } from "../plugins/font-store.js";
import { PluginSettingsPanelRegistry } from "../plugins/plugin-settings-panel-registry.js";
import { discoverPlugins } from "../plugins/discovery.js";
import {
  createElectronPluginRuntimeHost,
  isElectronSandboxDisabled,
  type ElectronPluginRuntimeHostOptions,
} from "./electron-host.js";
import { PluginManagerService } from "./plugin-manager-service.js";
import { installPluginSettingsPageIpc } from "./plugin-settings-page-ipc.js";
import { createPluginManagerWindow, type PluginManagerWindowOptions } from "./plugin-manager-window.js";

export interface YplusplusElectronApp {
  readonly commandLine: { hasSwitch(name: string): boolean };
  whenReady(): Promise<void>;
  on(event: "before-quit", listener: (event: { preventDefault(): void }) => void): void;
  quit(): void;
}

export interface YplusplusElectronDependencies {
  readonly app: YplusplusElectronApp;
  readonly BrowserWindow: ElectronPluginRuntimeHostOptions["BrowserWindow"] & PluginManagerWindowOptions["BrowserWindow"];
  readonly ipcMain: ElectronPluginRuntimeHostOptions["ipcMain"] & PluginManagerWindowOptions["ipcMain"];
  readonly MessageChannelMain: ElectronPluginRuntimeHostOptions["MessageChannelMain"];
  readonly Notification: ElectronPluginRuntimeHostOptions["Notification"];
}

export interface YplusplusBootstrapResult {
  readonly pluginRoot: string;
  readonly discovered: number;
  readonly rejected: number;
  readonly started: readonly string[];
  readonly waitingForTrust: readonly string[];
  readonly waitingForApproval: readonly string[];
  readonly failed: readonly string[];
}


async function seedBuiltinFontsPlugin(pluginRoot: string): Promise<{ directory: string; source: string; created: boolean }> {
  const runtimeDirectory = join(dirname(fileURLToPath(import.meta.url)), "assets");
  const source = join(runtimeDirectory, "builtin-plugins", "fonts");
  const directory = join(pluginRoot, "fonts");
  let created = false;
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("The built-in Fonts plugin path must be a regular directory.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await cp(source, directory, { recursive: true, errorOnExist: true, force: false });
    created = true;
  }
  return Object.freeze({ directory, source, created });
}

async function isUnmodifiedBuiltinFontsPlugin(directory: string, source: string): Promise<boolean> {
  try {
    const [installedManifest, bundledManifest, installedEntry, bundledEntry] = await Promise.all([
      readFile(join(directory, "yplusplus.plugin.json")),
      readFile(join(source, "yplusplus.plugin.json")),
      readFile(join(directory, "index.js")),
      readFile(join(source, "index.js")),
    ]);
    return installedManifest.equals(bundledManifest) && installedEntry.equals(bundledEntry);
  } catch {
    return false;
  }
}

function dataHome(): string {
  const configured = process.env.XDG_DATA_HOME;
  return configured && isAbsolute(configured) ? resolve(configured) : join(homedir(), ".local", "share");
}

/**
 * Start only explicitly trusted, capability-approved releases. Discovery alone
 * never grants execution trust, including for plugins requesting zero APIs.
 */
export async function startYplusplusMain(dependencies: YplusplusElectronDependencies): Promise<YplusplusBootstrapResult> {
  await dependencies.app.whenReady();

  const root = join(dataHome(), "yplusplus");
  const configuredPluginRoot = process.env.YPLUSPLUS_PLUGIN_DIR;
  const pluginRoot = configuredPluginRoot && isAbsolute(configuredPluginRoot)
    ? resolve(configuredPluginRoot)
    : join(root, "plugins");
  await mkdir(pluginRoot, { recursive: true, mode: 0o700 });
  const builtinFonts = await seedBuiltinFontsPlugin(pluginRoot);

  const discovery = await discoverPlugins(pluginRoot);
  const approvals = new PluginApprovalController();
  const enabledStore = new PluginEnabledStore({ filePath: join(root, "plugin-enabled.json") });
  const settingsStore = new PluginSettingsStore({ directory: join(root, "plugin-settings") });
  const fontStore = new FontStore({ directory: join(root, "fonts") });
  const bundledFonts = discovery.plugins.find((plugin) =>
    plugin.directory === builtinFonts.directory &&
    plugin.manifest.id === "dev.yplusplus.fonts" &&
    plugin.manifest.version === "1.0.0");
  if (builtinFonts.created && bundledFonts && await isUnmodifiedBuiltinFontsPlugin(builtinFonts.directory, builtinFonts.source)) {
    await approvals.trust(bundledFonts);
  }
  const settingsPanelRegistry = new PluginSettingsPanelRegistry();
  const report = await approvals.inspect(discovery);
  const runtime = createElectronPluginRuntimeHost({
    BrowserWindow: dependencies.BrowserWindow,
    ipcMain: dependencies.ipcMain,
    MessageChannelMain: dependencies.MessageChannelMain,
    Notification: dependencies.Notification,
    getApprovedPermissions: (id, version) => approvals.store.getApprovedPermissions(id, version),
    settingsStore,
    settingsPanelRegistry,
    isSandboxDisabled: () => isElectronSandboxDisabled(dependencies.app),
  });

  const managerService = new PluginManagerService({ pluginRoot, approvals, runtime, enabledStore });
  const started: string[] = [];
  const failed: string[] = [];
  for (const plugin of report.plugins) {
    if (plugin.state !== "READY" || !(await enabledStore.isEnabled(plugin.id, plugin.version))) continue;
    try {
      await runtime.start(plugin);
      started.push(plugin.id);
      console.info(`[Y++] Plugin started: ${plugin.id}@${plugin.version}`);
    } catch (error) {
      failed.push(plugin.id);
      console.error(`[Y++] Plugin failed to start: ${plugin.id}`, error);
    }
  }

  const waitingForTrust = report.plugins
    .filter((plugin) => plugin.state === "WAITING_FOR_TRUST")
    .map((plugin) => plugin.id);
  for (const plugin of waitingForTrust) console.info(`[Y++] Plugin awaits explicit trust: ${plugin}`);

  const waitingForApproval = report.plugins
    .filter((plugin) => plugin.state === "WAITING_FOR_APPROVAL")
    .map((plugin) => plugin.id);
  for (const plugin of waitingForApproval) console.info(`[Y++] Plugin awaits permission approval: ${plugin}`);
  for (const rejected of report.rejected) {
    console.warn("[Y++] Rejected plugin directory:", rejected.directory, rejected.issues);
  }

  const disposeSettingsPageIpc = installPluginSettingsPageIpc({
    ipcMain: dependencies.ipcMain,
    service: managerService,
    registry: settingsPanelRegistry,
    store: settingsStore,
    fonts: fontStore,
  });
  const managerWindow = createPluginManagerWindow({
    BrowserWindow: dependencies.BrowserWindow,
    ipcMain: dependencies.ipcMain,
    service: managerService,
  });
  if (process.argv.includes("--yplusplus-plugin-manager")) {
    if (isElectronSandboxDisabled(dependencies.app)) {
      console.error("[Y++] Plugin Manager was not opened because Chromium sandboxing is disabled.");
    } else {
      void managerWindow.open().catch((error) => console.error("[Y++] Plugin Manager failed to open:", error));
    }
  }

  let shutdownStarted = false;
  let allowQuit = false;
  dependencies.app.on("before-quit", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void Promise.allSettled(runtime.list().map((item) => runtime.unload(item.id)))
      .then((results) => {
        for (const result of results) {
          if (result.status === "rejected") console.error("[Y++] Runtime shutdown error:", result.reason);
        }
      })
      .finally(() => {
        disposeSettingsPageIpc();
        allowQuit = true;
        dependencies.app.quit();
      });
  });

  const result = Object.freeze({
    pluginRoot,
    discovered: discovery.plugins.length,
    rejected: discovery.rejected.length,
    started: Object.freeze(started),
    waitingForTrust: Object.freeze(waitingForTrust),
    waitingForApproval: Object.freeze(waitingForApproval),
    failed: Object.freeze(failed),
  });
  console.info("[Y++] Main-process integration ready", result);
  return result;
}
