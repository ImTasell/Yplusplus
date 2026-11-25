/**
 * Concrete Electron host wiring for the Y++ plugin runtime.
 *
 * Electron remains injected so unit tests and the core package do not need an
 * Electron dependency. Pass the real exports from the host application's
 * Electron main process.
 */
import { createPluginCapabilityFacade } from "../capabilities/broker.js";
import type { PluginApprovalProvider } from "../plugins/manager.js";
import type { PluginSettingsStore } from "../plugins/plugin-settings-store.js";
import type { PluginSettingsPanelRegistry } from "../plugins/plugin-settings-panel-registry.js";
import { PluginRpcSession } from "./rpc-session.js";
import { PluginRuntimeHost } from "./host.js";
import {
  createElectronMessageChannel,
  type ElectronMessageChannelMainLike,
} from "./electron-message-port.js";
import {
  createElectronPluginExecutionAdapter,
  resolveElectronPluginRuntimeAssets,
  type ElectronPluginExecutionOptions,
} from "./electron-execution.js";

export interface ElectronAppCommandLineLike {
  commandLine: {
    hasSwitch(name: string): boolean;
  };
}

/** Fail closed when Chromium's process-wide sandbox switch is disabled. */
export function isElectronSandboxDisabled(
  app: ElectronAppCommandLineLike,
  argv: readonly string[] = process.argv,
): boolean {
  return app.commandLine.hasSwitch("no-sandbox") ||
    argv.some((argument) => argument === "--no-sandbox" || argument.startsWith("--no-sandbox="));
}

export interface ElectronNotificationLike {
  show(): void;
}

export interface ElectronNotificationConstructor {
  new(options: { readonly title: string; readonly body: string }): ElectronNotificationLike;
}

export interface ElectronPluginRuntimeHostOptions {
  readonly BrowserWindow: ElectronPluginExecutionOptions["BrowserWindow"];
  readonly ipcMain: ElectronPluginExecutionOptions["ipcMain"];
  readonly MessageChannelMain: new () => ElectronMessageChannelMainLike;
  readonly Notification: ElectronNotificationConstructor;
  readonly getApprovedPermissions: PluginApprovalProvider;
  /** Shared host-owned persistent settings store; plugin identity is bound internally. */
  readonly settingsStore: PluginSettingsStore;
  readonly settingsPanelRegistry?: PluginSettingsPanelRegistry;
  /** Must detect --no-sandbox in the actual parent Electron/Chromium process. */
  readonly isSandboxDisabled: () => boolean;
  readonly preloadPath?: string;
  readonly bootstrapHtmlPath?: string;
  readonly startupTimeoutMs?: number;
  readonly executionStartupTimeoutMs?: number;
}

/**
 * Wire Electron MessageChannelMain, sandboxed BrowserWindows, the approval
 * store-backed capability broker, and native desktop notifications together.
 *
 * This creates a ready-to-use runtime host, but the Yapper main process must
 * still own plugin discovery, approval UI, and calls to start()/unload().
 */
export function createElectronPluginRuntimeHost(
  options: ElectronPluginRuntimeHostOptions,
): PluginRuntimeHost {
  const assets = resolveElectronPluginRuntimeAssets();
  const execution = createElectronPluginExecutionAdapter({
    BrowserWindow: options.BrowserWindow,
    ipcMain: options.ipcMain,
    preloadPath: options.preloadPath ?? assets.preloadPath,
    bootstrapHtmlPath: options.bootstrapHtmlPath ?? assets.bootstrapHtmlPath,
    isSandboxDisabled: options.isSandboxDisabled,
    ...(options.executionStartupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.executionStartupTimeoutMs }),
  });

  return new PluginRuntimeHost({
    createChannel: () => createElectronMessageChannel(
      () => new options.MessageChannelMain(),
    ),
    createSession: async (plugin) => {
      const facade = await createPluginCapabilityFacade(plugin, {
        getApprovedPermissions: options.getApprovedPermissions,
        settingsStore: options.settingsStore,
        ...(options.settingsPanelRegistry ? { settingsPanelRegistry: options.settingsPanelRegistry } : {}),
        notifications: async (_identity, request) => {
          const notification = new options.Notification({
            title: request.title,
            body: request.message,
          });
          notification.show();
        },
      });
      return new PluginRpcSession({ facade });
    },
    execution,
    ...(options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.startupTimeoutMs }),
  });
}
