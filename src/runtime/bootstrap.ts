/**
 * Y++ main-process bootstrap for the managed Yapper installation.
 *
 * This module is dynamically imported by the version-specific BOOT patch.
 * It owns discovery, persistent approvals, runtime startup, and shutdown.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PluginApprovalController } from "../plugins/approval-controller.js";
import { discoverPlugins } from "../plugins/discovery.js";
import { createElectronPluginRuntimeHost, isElectronSandboxDisabled } from "./electron-host.js";

export interface YplusplusElectronApp {
  readonly commandLine: { hasSwitch(name: string): boolean };
  whenReady(): Promise<void>;
  on(event: "before-quit", listener: (event: { preventDefault(): void }) => void): void;
  quit(): void;
}

export interface YplusplusElectronDependencies {
  readonly app: YplusplusElectronApp;
  readonly BrowserWindow: ConstructorParameters<typeof createElectronPluginRuntimeHost>[0]["BrowserWindow"];
  readonly ipcMain: ConstructorParameters<typeof createElectronPluginRuntimeHost>[0]["ipcMain"];
  readonly MessageChannelMain: ConstructorParameters<typeof createElectronPluginRuntimeHost>[0]["MessageChannelMain"];
  readonly Notification: ConstructorParameters<typeof createElectronPluginRuntimeHost>[0]["Notification"];
}

export interface YplusplusBootstrapResult {
  readonly pluginRoot: string;
  readonly discovered: number;
  readonly rejected: number;
  readonly started: readonly string[];
  readonly waitingForApproval: readonly string[];
  readonly failed: readonly string[];
}

function dataHome(): string {
  const configured = process.env.XDG_DATA_HOME;
  return configured && isAbsolute(configured) ? resolve(configured) : join(homedir(), ".local", "share");
}

/**
 * Start only plugins that are READY under the persistent host approval store.
 * A plugin requesting permissions cannot run until a trusted approval UI
 * explicitly grants them. No implicit permission grants are made here.
 */
export async function startYplusplusMain(dependencies: YplusplusElectronDependencies): Promise<YplusplusBootstrapResult> {
  await dependencies.app.whenReady();

  const root = join(dataHome(), "yplusplus");
  const pluginRoot = join(root, "plugins");
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

  const waitingForApproval = report.plugins
    .filter((plugin) => plugin.state === "WAITING_FOR_APPROVAL")
    .map((plugin) => plugin.id);
  for (const plugin of waitingForApproval) {
    console.info(`[Y++] Plugin awaits permission approval: ${plugin}`);
  }
  for (const rejected of report.rejected) {
    console.warn("[Y++] Rejected plugin directory:", rejected.directory, rejected.issues);
  }

  let quitting = false;
  dependencies.app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void Promise.all(runtime.list().map((item) => runtime.unload(item.id)))
      .catch((error: unknown) => console.error("[Y++] Runtime shutdown error:", error))
      .finally(() => dependencies.app.quit());
  });

  const result = Object.freeze({
    pluginRoot,
    discovered: discovery.plugins.length,
    rejected: discovery.rejected.length,
    started: Object.freeze(started),
    waitingForApproval: Object.freeze(waitingForApproval),
    failed: Object.freeze(failed),
  });
  console.info("[Y++] Main-process integration ready", result);
  return result;
}
