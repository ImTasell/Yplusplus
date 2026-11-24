/**
 * Sandboxed Electron renderer execution adapter.
 *
 * This adapter is intentionally dependency-injected: the core package does
 * not import Electron. The caller must provide real Electron constructors,
 * IPC main, and paths to the packaged preload/bootstrap assets.
 *
 * IMPORTANT: sandbox:true is not a security boundary when Chromium is launched
 * with --no-sandbox. isSandboxDisabled must reflect the actual app command line.
 */
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PLUGIN_MANIFEST_FILE,
  validatePluginManifest,
} from "../plugins/manifest.js";
import type { ManagedPlugin } from "../plugins/manager.js";
import type { ElectronMessagePortMainLike } from "./electron-message-port.js";
import { getElectronTransferablePort } from "./electron-message-port.js";
import type { RpcMessagePort } from "./message-port.js";
import type { PluginExecutionAdapter, PluginExecutionHandle } from "./host.js";

interface ElectronEvent {
  preventDefault(): void;
}

interface ElectronWebRequestLike {
  onBeforeRequest(
    filter: { readonly urls: readonly string[] },
    listener: ((details: { readonly url: string }, callback: (result: { cancel: boolean }) => void) => void) | null,
  ): void;
}

interface ElectronSessionLike {
  readonly webRequest: ElectronWebRequestLike;
  setPermissionRequestHandler(
    handler: ((webContents: ElectronWebContentsLike, permission: string, callback: (allowed: boolean) => void) => void) | null,
  ): void;
  setPermissionCheckHandler(
    handler: ((webContents: ElectronWebContentsLike, permission: string) => boolean) | null,
  ): void;
}

interface ElectronWebContentsLike {
  readonly session: ElectronSessionLike;
  readonly mainFrame: unknown;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
  postMessage(channel: string, message: unknown, transfer?: readonly ElectronMessagePortMainLike[]): void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  isDestroyed(): boolean;
}

interface ElectronBrowserWindowLike {
  readonly webContents: ElectronWebContentsLike;
  loadFile(filePath: string): Promise<void>;
  destroy(): void;
  isDestroyed(): boolean;
  once(event: "closed", listener: () => void): this;
}

interface ElectronIpcMainEvent {
  readonly sender: ElectronWebContentsLike;
  readonly senderFrame?: unknown;
}

interface ElectronIpcMainLike {
  on(channel: string, listener: (event: ElectronIpcMainEvent, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: ElectronIpcMainEvent, ...args: unknown[]) => void): void;
}

export interface ElectronPluginWindowOptions {
  readonly width: 1;
  readonly height: 1;
  readonly show: false;
  readonly skipTaskbar: true;
  readonly focusable: false;
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

export interface ElectronPluginExecutionOptions {
  readonly BrowserWindow: new (options: ElectronPluginWindowOptions) => ElectronBrowserWindowLike;
  readonly ipcMain: ElectronIpcMainLike;
  readonly preloadPath: string;
  readonly bootstrapHtmlPath: string;
  /** Must detect the real process/app --no-sandbox state, not merely webPreferences. */
  readonly isSandboxDisabled: () => boolean;
  readonly startupTimeoutMs?: number;
  readonly maxEntryBytes?: number;
}

export interface ElectronPluginExecutionAdapter extends PluginExecutionAdapter {
  readonly options: ElectronPluginExecutionOptions;
}

const CONNECT_CHANNEL = "yplusplus:plugin-connect";
const READY_CHANNEL = "yplusplus:plugin-bridge-ready";
const MAX_ENTRY_BYTES_DEFAULT = 2 * 1024 * 1024;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

/** Re-read and revalidate the manifest and entry immediately before execution. */
export async function readPluginEntry(
  plugin: Pick<ManagedPlugin, "id" | "name" | "version" | "directory">,
  maxEntryBytes = MAX_ENTRY_BYTES_DEFAULT,
): Promise<string> {
  if (!Number.isSafeInteger(maxEntryBytes) || maxEntryBytes < 1 || maxEntryBytes > 16 * 1024 * 1024) {
    throw new RangeError("maxEntryBytes must be an integer from 1 to 16777216.");
  }

  const root = await realpath(plugin.directory);
  const manifestPath = path.join(root, PLUGIN_MANIFEST_FILE);
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
    throw new Error("Plugin manifest must be a regular, non-symlink file.");
  }
  const rawManifest = await readFile(manifestPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest) as unknown;
  } catch {
    throw new Error("Plugin manifest is not valid JSON.");
  }
  const validation = validatePluginManifest(parsed);
  if (!validation.ok) throw new Error("Plugin manifest failed validation.");

  const manifest = validation.manifest;
  if (manifest.id !== plugin.id || manifest.name !== plugin.name || manifest.version !== plugin.version) {
    throw new Error("Plugin metadata changed after discovery; inspect it again before execution.");
  }

  const entryPath = path.resolve(root, ...manifest.entry.split("/"));
  const resolvedEntry = await realpath(entryPath);
  if (!isInside(root, resolvedEntry)) {
    throw new Error("Plugin entry resolves outside its installation directory.");
  }
  const entryInfo = await stat(resolvedEntry);
  if (!entryInfo.isFile()) throw new Error("Plugin entry must be a regular file.");
  if (entryInfo.size > maxEntryBytes) throw new Error("Plugin entry exceeds the configured size limit.");

  // Read the canonical path after containment checks. Plugins should ship a
  // self-contained ESM entry; relative imports from blob URLs are unsupported.
  const source = await readFile(resolvedEntry, "utf8");
  if (Buffer.byteLength(source, "utf8") > maxEntryBytes) {
    throw new Error("Plugin entry exceeds the configured size limit.");
  }
  return source;
}

export function createElectronPluginWindowOptions(
  preloadPath: string,
  partition: string,
): ElectronPluginWindowOptions {
  return Object.freeze({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: Object.freeze({
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
      partition,
    }),
  });
}

function createActivationScript(source: string): string {
  const literal = JSON.stringify(source);
  return `(async () => {
    const source = ${literal};
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
      const pluginModule = await import(url);
      if (!pluginModule || typeof pluginModule.activate !== "function") {
        throw new Error("Plugin entry must export an activate() function.");
      }
      await pluginModule.activate();
      return true;
    } finally {
      URL.revokeObjectURL(url);
    }
  })()`;
}

/**
 * Creates one hidden, isolated renderer per plugin. This does not grant DOM UI
 * or network access; it is a background execution context for the v1 API.
 */
export function createElectronPluginExecutionAdapter(
  options: ElectronPluginExecutionOptions,
): ElectronPluginExecutionAdapter {
  const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
  const maxEntryBytes = options.maxEntryBytes ?? MAX_ENTRY_BYTES_DEFAULT;
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 100 || startupTimeoutMs > 60_000) {
    throw new RangeError("startupTimeoutMs must be an integer from 100 to 60000.");
  }

  return {
    options,
    async start(plugin, pluginPort: RpcMessagePort): Promise<PluginExecutionHandle> {
      if (options.isSandboxDisabled()) {
        throw new Error("Y++ plugin execution is disabled because Chromium was launched with --no-sandbox.");
      }
      const nativePort = getElectronTransferablePort(pluginPort);
      const source = await readPluginEntry(plugin, maxEntryBytes);
      const nonce = randomUUID();
      const partition = `yplusplus-plugin-${plugin.id}-${nonce}`;
      const bootstrapUrl = pathToFileURL(options.bootstrapHtmlPath).href;
      const window = new options.BrowserWindow(
        createElectronPluginWindowOptions(options.preloadPath, partition),
      );
      const contents = window.webContents;
      let exited = false;
      let disposed = false;
      let exitReason: unknown;
      const exitListeners = new Set<(reason?: unknown) => void>();
      let rejectStartup!: (error: Error) => void;
      const failed = new Promise<never>((_, reject) => { rejectStartup = reject; });

      const notifyExit = (reason?: unknown): void => {
        if (exited) return;
        exited = true;
        exitReason = reason;
        for (const listener of exitListeners) listener(reason);
        rejectStartup(new Error("Plugin renderer exited during startup."));
      };

      const onReady = (event: ElectronIpcMainEvent, receivedNonce: unknown): void => {
        if (event.sender !== contents || event.senderFrame !== contents.mainFrame) return;
        if (receivedNonce !== nonce) return;
        options.ipcMain.removeListener(READY_CHANNEL, onReady);
        resolveBridge();
      };

      let resolveBridge!: () => void;
      const bridgeReady = new Promise<void>((resolve) => { resolveBridge = resolve; });
      options.ipcMain.on(READY_CHANNEL, onReady);

      const onBeforeRequest = (
        details: { readonly url: string },
        callback: (result: { cancel: boolean }) => void,
      ): void => callback({ cancel: details.url !== bootstrapUrl });
      contents.session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, onBeforeRequest);
      contents.session.setPermissionRequestHandler((_sender, _permission, callback) => callback(false));
      contents.session.setPermissionCheckHandler(() => false);

      const denyNavigation = (event: ElectronEvent): void => event.preventDefault();
      contents.on("will-navigate", denyNavigation);
      contents.on("will-redirect", denyNavigation);
      contents.on("will-attach-webview", denyNavigation);
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("render-process-gone", (_event, details) => {
        notifyExit(details ?? new Error("Plugin renderer process exited."));
      });
      contents.on("destroyed", () => notifyExit(new Error("Plugin webContents was destroyed.")));
      window.once("closed", () => notifyExit(new Error("Plugin window was closed.")));

      const cleanup = (): void => {
        if (disposed) return;
        disposed = true;
        options.ipcMain.removeListener(READY_CHANNEL, onReady);
        contents.session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, null);
        contents.session.setPermissionRequestHandler(null);
        contents.session.setPermissionCheckHandler(null);
        if (!window.isDestroyed()) window.destroy();
      };

      try {
        const startup = (async (): Promise<void> => {
          await window.loadFile(options.bootstrapHtmlPath);
          if (exited) throw new Error("Plugin renderer exited before bridge setup.");
          contents.postMessage(CONNECT_CHANNEL, { nonce }, [nativePort]);
          await bridgeReady;
          if (exited) throw new Error("Plugin renderer exited before activation.");
          await contents.executeJavaScript(createActivationScript(source), false);
          if (exited) throw new Error("Plugin renderer exited during activation.");
        })();

        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Electron plugin renderer startup timed out.")), startupTimeoutMs);
        });
        try {
          await Promise.race([startup, failed, timedOut]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      } catch (error) {
        cleanup();
        throw error;
      }

      return {
        terminate: async () => cleanup(),
        onExit: (listener) => {
          if (exited) {
            listener(exitReason);
            return () => undefined;
          }
          exitListeners.add(listener);
          return () => { exitListeners.delete(listener); };
        },
      };
    },
  };
}
