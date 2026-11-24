import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ManagedPlugin } from "../../src/plugins/manager.js";
import {
  createElectronPluginExecutionAdapter,
  createElectronPluginWindowOptions,
  readPluginEntry,
  type ElectronPluginExecutionOptions,
} from "../../src/runtime/electron-execution.js";
import {
  ElectronMessagePortAdapter,
  type ElectronMessagePortMainLike,
} from "../../src/runtime/electron-message-port.js";

class FakeNativePort implements ElectronMessagePortMainLike {
  postMessage(_message: unknown): void {}
  on(_event: "message", _listener: (event: { readonly data: unknown }) => void): unknown { return this; }
  off(_event: "message", _listener: (event: { readonly data: unknown }) => void): unknown { return this; }
  start(): void {}
  close(): void {}
}

class FakeIpcMain {
  readonly listeners = new Map<string, (event: any, ...args: unknown[]) => void>();
  suppressBridgeReady = false;
  on(channel: string, listener: (event: any, ...args: unknown[]) => void): void {
    this.listeners.set(channel, listener);
  }
  removeListener(channel: string, listener: (event: any, ...args: unknown[]) => void): void {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }
  emit(channel: string, event: any, ...args: unknown[]): void {
    if (this.suppressBridgeReady && channel === "yplusplus:plugin-bridge-ready") return;
    this.listeners.get(channel)?.(event, ...args);
  }
}

class FakeSession {
  readonly webRequest = {
    listener: undefined as ((details: { readonly url: string }, callback: (result: { cancel: boolean }) => void) => void) | null | undefined,
    onBeforeRequest: (_filter: { readonly urls: readonly string[] }, listener: ((details: { readonly url: string }, callback: (result: { cancel: boolean }) => void) => void) | null) => {
      this.webRequest.listener = listener;
    },
  };
  permissionRequestHandler: unknown = undefined;
  permissionCheckHandler: unknown = undefined;
  setPermissionRequestHandler(handler: unknown): void { this.permissionRequestHandler = handler; }
  setPermissionCheckHandler(handler: unknown): void { this.permissionCheckHandler = handler; }
}

class FakeWindow {
  static latest: FakeWindow | undefined;
  readonly session = new FakeSession();
  readonly mainFrame = {};
  readonly listeners = new Map<string, (...args: any[]) => void>();
  readonly webContents = {
    session: this.session,
    mainFrame: this.mainFrame,
    on: (event: string, listener: (...args: any[]) => void) => {
      this.listeners.set(event, listener);
      return this.webContents;
    },
    once: (event: string, listener: (...args: any[]) => void) => {
      this.listeners.set(event, listener);
      return this.webContents;
    },
    removeListener: (event: string) => {
      this.listeners.delete(event);
      return this.webContents;
    },
    setWindowOpenHandler: (handler: () => { action: "deny" }) => { this.openHandler = handler; },
    postMessage: (channel: string, message: unknown, transfer?: readonly ElectronMessagePortMainLike[]) => {
      this.transferred = transfer?.[0];
      if (channel === "yplusplus:plugin-connect") {
        ipc.emit("yplusplus:plugin-bridge-ready", {
          sender: this.webContents,
          senderFrame: this.mainFrame,
        }, (message as { nonce: string }).nonce);
      }
    },
    executeJavaScript: async (code: string) => {
      this.executedScript = code;
      return true;
    },
    isDestroyed: () => this.destroyed,
  };
  openHandler: (() => { action: "deny" }) | undefined;
  transferred: ElectronMessagePortMainLike | undefined;
  executedScript = "";
  destroyed = false;
  loadPath = "";
  constructor(readonly options: unknown) { FakeWindow.latest = this; }
  once(event: "closed", listener: () => void): this { this.listeners.set(event, listener); return this; }
  async loadFile(filePath: string): Promise<void> { this.loadPath = filePath; }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.get("closed")?.();
  }
  isDestroyed(): boolean { return this.destroyed; }
}

const ipc = new FakeIpcMain();

function fixture(): ManagedPlugin {
  return {
    id: "dev.example.notification",
    name: "Notification Example",
    version: "1.0.0",
    directory: "/unused",
    state: "READY",
    requestedPermissions: ["ui.notifications"],
    approvedPermissions: ["ui.notifications"],
    deniedPermissions: [],
    compatibility: { compatible: true, pluginApiVersion: 1, hostApiVersion: 1 },
  };
}

async function makePluginDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yplusplus-plugin-"));
  await writeFile(path.join(directory, "yplusplus.plugin.json"), JSON.stringify({
    manifestVersion: 1,
    id: "dev.example.notification",
    name: "Notification Example",
    version: "1.0.0",
    description: "test",
    apiVersion: 1,
    entry: "index.js",
    permissions: ["ui.notifications"],
  }));
  await writeFile(path.join(directory, "index.js"), "export async function activate() {}");
  return directory;
}

function options(overrides: Partial<ElectronPluginExecutionOptions> = {}): ElectronPluginExecutionOptions {
  return {
    BrowserWindow: FakeWindow as unknown as ElectronPluginExecutionOptions["BrowserWindow"],
    ipcMain: ipc,
    preloadPath: "/runtime/plugin-preload.cjs",
    bootstrapHtmlPath: "/runtime/plugin-host.html",
    isSandboxDisabled: () => false,
    ...overrides,
  };
}

test("window options explicitly disable Node and enable Electron renderer sandboxing", () => {
  const value = createElectronPluginWindowOptions("/preload.cjs", "yplusplus-plugin-test");
  assert.equal(value.show, false);
  assert.equal(value.webPreferences.sandbox, true);
  assert.equal(value.webPreferences.contextIsolation, true);
  assert.equal(value.webPreferences.nodeIntegration, false);
  assert.equal(value.webPreferences.webSecurity, true);
  assert.equal(value.webPreferences.webviewTag, false);
});

test("entry reader revalidates metadata and reads a contained ESM entry", async () => {
  const directory = await makePluginDirectory();
  try {
    const source = await readPluginEntry({ ...fixture(), directory });
    assert.match(source, /export async function activate/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("entry reader rejects a symlink that escapes the plugin root", async () => {
  const directory = await makePluginDirectory();
  const outside = path.join(path.dirname(directory), "outside-plugin-entry.js");
  try {
    await writeFile(outside, "export async function activate() {}");
    await rm(path.join(directory, "index.js"));
    await symlink(outside, path.join(directory, "index.js"));
    await assert.rejects(readPluginEntry({ ...fixture(), directory }), /outside/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("starts a sandboxed hidden renderer, transfers only its plugin port, and awaits activation", async () => {
  const directory = await makePluginDirectory();
  const nativePort = new FakeNativePort();
  const pluginPort = new ElectronMessagePortAdapter(nativePort);
  try {
    const adapter = createElectronPluginExecutionAdapter(options());
    const handle = await adapter.start({ ...fixture(), directory }, pluginPort);
    const window = FakeWindow.latest!;
    const windowOptions = window.options as ReturnType<typeof createElectronPluginWindowOptions>;
    assert.equal(windowOptions.webPreferences.sandbox, true);
    assert.equal(windowOptions.webPreferences.nodeIntegration, false);
    assert.equal(windowOptions.webPreferences.contextIsolation, true);
    assert.equal(window.transferred, nativePort);
    assert.match(window.executedScript, /pluginModule\.activate/);
    assert.equal(window.openHandler?.().action, "deny");
    const blocked: Array<{ cancel: boolean }> = [];
    window.session.webRequest.listener?.({ url: "https://example.com/" }, (result) => blocked.push(result));
    window.session.webRequest.listener?.({ url: "file:///runtime/plugin-host.html" }, (result) => blocked.push(result));
    assert.deepEqual(blocked, [{ cancel: true }, { cancel: false }]);
    let exits = 0;
    handle.onExit(() => { exits += 1; });
    await handle.terminate();
    assert.equal(window.destroyed, true);
    assert.equal(exits, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses plugin execution when Chromium's global sandbox is disabled", async () => {
  const directory = await makePluginDirectory();
  try {
    const adapter = createElectronPluginExecutionAdapter(options({ isSandboxDisabled: () => true }));
    await assert.rejects(
      adapter.start({ ...fixture(), directory }, new ElectronMessagePortAdapter(new FakeNativePort())),
      /--no-sandbox/,
    );
    assert.equal(FakeWindow.latest, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("does not read or create a renderer after host cancellation", async () => {
  FakeWindow.latest = undefined;
  const directory = await makePluginDirectory();
  const controller = new AbortController();
  controller.abort();
  try {
    const adapter = createElectronPluginExecutionAdapter(options());
    await assert.rejects(
      adapter.start({ ...fixture(), directory }, new ElectronMessagePortAdapter(new FakeNativePort()), controller.signal),
      /cancelled/,
    );
    assert.equal(FakeWindow.latest, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("host abort destroys a renderer that is waiting for its preload handshake", async () => {
  FakeWindow.latest = undefined;
  ipc.suppressBridgeReady = true;
  const directory = await makePluginDirectory();
  const controller = new AbortController();
  try {
    const adapter = createElectronPluginExecutionAdapter(options());
    const starting = adapter.start(
      { ...fixture(), directory },
      new ElectronMessagePortAdapter(new FakeNativePort()),
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const window = FakeWindow.latest;
    assert.ok(window);
    controller.abort();
    await assert.rejects(starting, /renderer exited|cancelled/);
    assert.equal(window.destroyed, true);
  } finally {
    ipc.suppressBridgeReady = false;
    await rm(directory, { recursive: true, force: true });
  }
});
