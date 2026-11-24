/**
 * Y++ main-process bootstrap for the managed Yapper installation.
 *
 * This module is dynamically imported by the version-specific BOOT patch.
 * It owns discovery, persistent execution trust, capability approvals,
 * runtime startup, and shutdown.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PluginApprovalController } from "../plugins/approval-controller.js";
import { discoverPlugins } from "../plugins/discovery.js";
import {
  createElectronPluginRuntimeHost,
  isElectronSandboxDisabled,
  type ElectronPluginRuntimeHostOptions,
} from "./electron-host.js";

export interface YplusplusElectronApp {
  readonly commandLine: { hasSwitch(name: string): boolean };
  whenReady(): Promise<void>;
  on(event: "before-quit", listener: (event: { preventDefault(): void }) => void): void;
  quit(): void;
}

export interface YplusplusElectronDependencies {
  readonly app: YplusplusElectronApp;
  readonly BrowserWindow: ElectronPluginRuntimeHostOptions["BrowserWindow"];
  readonly ipcMain: ElectronPluginRuntimeHostOptions["ipcMain"];
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

  const discovery = await discoverPlugins(pluginRoot);
  const approvals = new PluginApprovalController();
  const report = await approvals.inspect(discovery);
  const runtime = createElectronPluginRuntimeHost({
    BrowserWindow: dependencies.BrowserWindow,
    ipcMain: dependencies.ipcMain,
    MessageChannelMain: dependencies.MessageChannelMain,
    Notification: dependencies.Notification,
    getApprovedPermissions: (id, version) => approvals.store.getApprovedPermissions(id, version),
    isSandboxDisabled: () => isElectronSandboxDisabled(dependencies.app),
  });

  const started: string[] = [];
  const failed: string[] = [];
  for (const plugin of report.plugins) {
    if (plugin.state !== "READY") continue;
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
  for (const plugin of waitingForTrust) {
    console.info(`[Y++] Plugin awaits explicit trust: ${plugin}`);
  }

  const waitingForApproval = report.plugins
    .filter((plugin) => plugin.state === "WAITING_FOR_APPROVAL")
    .map((plugin) => plugin.id);
  for (const plugin of waitingForApproval) {
    console.info(`[Y++] Plugin awaits permission approval: ${plugin}`);
  }
  for (const rejected of report.rejected) {
    console.warn("[Y++] Rejected plugin directory:", rejected.directory, rejected.issues);
  }

  const managerService = new PluginManagerService({ pluginRoot, approvals, runtime });\n  const managerWindow = createPluginManagerWindow({\n    BrowserWindow: dependencies.BrowserWindow,\n    ipcMain: dependencies.ipcMain,\n    service: managerService,\n  });\n  if (process.argv.includes("--yplusplus-plugin-manager")) {\n    if (isElectronSandboxDisabled(dependencies.app)) {\n      console.error("[Y++] Plugin Manager was not opened because Chromium sandboxing is disabled.");\n    } else {\n      void managerWindow.open().catch((error) => console.error("[Y++] Plugin Manager failed to open:", error));\n    }\n  }\n\n  let shutdownStarted = false;
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
