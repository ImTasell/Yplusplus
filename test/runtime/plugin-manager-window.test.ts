import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createPluginManagerWindow } from "../../src/runtime/plugin-manager-window.js";

class FakeIpcMain {
  readonly handlers = new Map<string, (event: any, ...args: unknown[]) => unknown>();
  readonly removed: string[] = [];
  handle(channel: string, listener: (event: any, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
    this.removed.push(channel);
  }
}

class FakeWindow {
  static latest: FakeWindow | undefined;
  readonly mainFrame: { url?: string } = {};
  readonly listeners = new Map<string, (...args: any[]) => void>();
  readonly permissionCalls: boolean[] = [];
  readonly webContents = {
    mainFrame: this.mainFrame,
    session: {
      webRequest: { onBeforeRequest: (_filter: unknown, _listener: unknown) => undefined },
      setPermissionRequestHandler: (handler: unknown) => this.permissionCalls.push(handler === null),
      setPermissionCheckHandler: (handler: unknown) => this.permissionCalls.push(handler === null),
    },
    on: (event: string, listener: (...args: any[]) => void) => {
      this.listeners.set(event, listener);
      return this.webContents;
    },
    setWindowOpenHandler: (_handler: () => { action: "deny" }) => undefined,
    isDestroyed: () => false,
  };
  readonly options: any;
  shown = 0;
  focused = 0;
  destroyed = false;
  constructor(options: any) { this.options = options; FakeWindow.latest = this; }
  once(event: string, listener: () => void): this {
    this.listeners.set(event, listener);
    if (event === "ready-to-show") listener();
    return this;
  }
  async loadFile(filePath: string): Promise<void> {
    this.mainFrame.url = pathToFileURL(filePath).href;
  }
  show(): void { this.shown += 1; }
  focus(): void { this.focused += 1; }
  isDestroyed(): boolean { return this.destroyed; }
}

test("manager window is sandboxed and accepts IPC only from its own main frame", async () => {
  const ipc = new FakeIpcMain();
  let refreshCalls = 0;
  const service = {
    refresh: async () => { refreshCalls += 1; return { plugins: [], rejected: [] }; },
    trust: async () => ({ plugins: [], rejected: [] }),
    untrust: async () => ({ plugins: [], rejected: [] }),
    approve: async () => ({ plugins: [], rejected: [] }),
    revoke: async () => ({ plugins: [], rejected: [] }),
    unload: async () => ({ plugins: [], rejected: [] }),
    start: async () => ({ plugins: [], rejected: [] }),
  };

  const manager = createPluginManagerWindow({
    BrowserWindow: FakeWindow as never,
    ipcMain: ipc as never,
    service: service as never,
  });
  await manager.open();

  const window = FakeWindow.latest!;
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.devTools, false);
  assert.equal(window.shown, 1);

  const refresh = ipc.handlers.get("yplusplus:manager:refresh")!;
  await assert.rejects(
    Promise.resolve(refresh({ sender: {}, senderFrame: window.mainFrame })),
    /Unauthorized manager request/,
  );
  await assert.rejects(
    Promise.resolve(refresh({ sender: window.webContents, senderFrame: { url: window.mainFrame.url } })),
    /Unauthorized manager request/,
  );

  const snapshot = await refresh({ sender: window.webContents, senderFrame: window.mainFrame });
  assert.deepEqual(snapshot, { plugins: [], rejected: [] });
  assert.equal(refreshCalls, 1);

  const closed = window.listeners.get("closed");
  closed?.();
  assert.equal(ipc.handlers.size, 0);
  assert.equal(ipc.removed.length, 7);
});
