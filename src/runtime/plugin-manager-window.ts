import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import type { PluginManagerService } from "./plugin-manager-service.js";

interface ManagerSession {
  readonly webRequest: {
    onBeforeRequest(
      filter: { readonly urls: string[] },
      listener: ((details: { readonly url: string }, callback: (result: { cancel: boolean }) => void) => void) | null,
    ): void;
  };
  setPermissionRequestHandler(handler: ((_contents: unknown, _permission: string, callback: (allowed: boolean) => void) => void) | null): void;
  setPermissionCheckHandler(handler: (() => boolean) | null): void;
}
interface ManagerWebContents {
  readonly mainFrame: unknown;
  readonly session: ManagerSession;
  on(event: string, listener: (...args: any[]) => void): this;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
  isDestroyed(): boolean;
}
interface ManagerWindow {
  readonly webContents: ManagerWebContents;
  loadFile(path: string): Promise<void>;
  show(): void;
  focus(): void;
  destroy(): void;
  isDestroyed(): boolean;
  once(event: "closed" | "ready-to-show", listener: () => void): this;
}
interface ManagerIpcEvent {
  readonly sender: ManagerWebContents;
  readonly senderFrame?: { readonly url?: string } | null;
}
interface ManagerIpcMain {
  handle(channel: string, listener: (event: ManagerIpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}
interface ManagerBrowserWindowOptions {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly show: boolean;
  readonly title: string;
  readonly backgroundColor: string;
  readonly autoHideMenuBar: boolean;
  readonly webPreferences: Readonly<{
    preload: string;
    sandbox: true;
    contextIsolation: true;
    nodeIntegration: false;
    webSecurity: true;
    allowRunningInsecureContent: false;
    webviewTag: false;
    devTools: false;
    partition: string;
  }>;
}

export interface PluginManagerWindowOptions {
  readonly BrowserWindow: new (options: ManagerBrowserWindowOptions) => ManagerWindow;
  readonly ipcMain: ManagerIpcMain;
  readonly service: PluginManagerService;
}

const CHANNELS = [
  "yplusplus:manager:refresh",
  "yplusplus:manager:trust",
  "yplusplus:manager:untrust",
  "yplusplus:manager:approve",
  "yplusplus:manager:revoke",
  "yplusplus:manager:unload",
  "yplusplus:manager:start",
] as const;

export function createPluginManagerWindow(options: PluginManagerWindowOptions): { open(): Promise<void> } {
  let window: ManagerWindow | undefined;
  let opening: Promise<void> | undefined;

  const open = async (): Promise<void> => {
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
      return;
    }
    if (opening) return opening;
    opening = (async () => {
      const directory = dirname(fileURLToPath(import.meta.url));
      const htmlPath = join(directory, "assets", "plugin-manager.html");
      const preloadPath = join(directory, "assets", "plugin-manager-preload.cjs");
      const managerUrl = pathToFileURL(htmlPath).href;
      const assetPrefix = pathToFileURL(join(directory, "assets") + "/").href;
      const created = new options.BrowserWindow({
        width: 940,
        height: 720,
        minWidth: 640,
        minHeight: 520,
        show: false,
        title: "Y++ Plugin Manager",
        backgroundColor: "#111318",
        autoHideMenuBar: true,
        webPreferences: {
          preload: preloadPath,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          devTools: false,
          partition: "yplusplus-plugin-manager",
        },
      });
      window = created;
      const isAuthorized = (event: ManagerIpcEvent): boolean =>
        event.sender === created.webContents &&
        event.senderFrame === created.webContents.mainFrame &&
        event.senderFrame?.url === managerUrl &&
        !created.webContents.isDestroyed();

      const handlers: readonly [string, (event: ManagerIpcEvent, ...args: unknown[]) => unknown][] = [
        [CHANNELS[0], async (event) => { if (!isAuthorized(event)) throw new Error("Unauthorized manager request."); return options.service.refresh(); }],
        [CHANNELS[1], async (event, id, version) => { if (!isAuthorized(event)) throw new Error("Unauthorized manager request."); return options.service.trust(id, version); }],
        [CHANNELS[2], async (event, id, version) => { if (!isAuthorized(event)) throw new Error("Unauthorized manager request."); return options.service.untrust(id, version); }],
        [CHANNELS[3], async (event, id, version, capabilities) => { if (!isAuthorized(event)) throw new Error("Unauthorized manager request."); return options.service.approve(id, version, capabilities); }],
        [CHANNELS[4], async (event, id, version, capabilities) => { if (!isAuthorized(event)) throw new Error("Unauthorized manager request."); return options.service.revoke(id, version, capabilities); }],
        [CHANNELS[5], async (event, id, version) => { if (!isAuthorized(event)) throw new Error("Unauthorized manager request."); return options.service.unload(id, version); }],
        [CHANNELS[6], async (event, id, version) => { if (!isAuthorized(event)) throw new Error("Unauthorized manager request."); return options.service.start(id, version); }],
      ];
      for (const [channel, handler] of handlers) options.ipcMain.handle(channel, handler);

      created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      created.webContents.on("will-navigate", (event: { preventDefault(): void }, url: string) => {
        if (url !== managerUrl) event.preventDefault();
      });
      created.webContents.session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
        callback({ cancel: !details.url.startsWith(assetPrefix) });
      });
      created.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      created.webContents.session.setPermissionCheckHandler(() => false);
      created.once("ready-to-show", () => { if (!created.isDestroyed()) created.show(); });
      created.once("closed", () => {
        for (const channel of CHANNELS) options.ipcMain.removeHandler(channel);
        if (window === created) window = undefined;
      });
      try {
        await created.loadFile(htmlPath);
      } catch (error) {
        for (const channel of CHANNELS) options.ipcMain.removeHandler(channel);
        if (!created.isDestroyed()) created.destroy();
        window = undefined;
        throw error;
      }
    })().finally(() => { opening = undefined; });
    return opening;
  };

  return Object.freeze({ open });
}
