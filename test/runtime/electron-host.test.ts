import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ManagedPlugin } from "../../src/plugins/manager.js";
import {
  createElectronPluginRuntimeHost,
  isElectronSandboxDisabled,
  type ElectronPluginRuntimeHostOptions,
} from "../../src/runtime/electron-host.js";
import type { ElectronMessageChannelMainLike, ElectronMessagePortMainLike } from "../../src/runtime/electron-message-port.js";
import type { ElectronPluginExecutionOptions } from "../../src/runtime/electron-execution.js";

class Port implements ElectronMessagePortMainLike {
  peer: Port | undefined;
  readonly listeners = new Set<(event: { readonly data: unknown }) => void>();
  closed = false;
  postMessage(message: unknown): void {
    if (this.closed) throw new Error("closed");
    queueMicrotask(() => {
      for (const listener of this.peer?.listeners ?? []) listener({ data: message });
    });
  }
  on(_event: "message", listener: (event: { readonly data: unknown }) => void): unknown {
    this.listeners.add(listener);
    return this;
  }
  off(_event: "message", listener: (event: { readonly data: unknown }) => void): unknown {
    this.listeners.delete(listener);
    return this;
  }
  start(): void {}
  close(): void { this.closed = true; }
}

class Channel implements ElectronMessageChannelMainLike {
  readonly port1 = new Port();
  readonly port2 = new Port();
  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

class IpcMain {
  readonly listeners = new Map<string, (event: any, ...args: unknown[]) => void>();
  on(channel: string, listener: (event: any, ...args: unknown[]) => void): void {
    this.listeners.set(channel, listener);
  }
  removeListener(channel: string, listener: (event: any, ...args: unknown[]) => void): void {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }
  emit(channel: string, event: any, ...args: unknown[]): void {
    this.listeners.get(channel)?.(event, ...args);
  }
}

class Session {
  readonly webRequest = {
    onBeforeRequest: (_filter: unknown, _listener: unknown) => undefined,
  };
  setPermissionRequestHandler(_handler: unknown): void {}
  setPermissionCheckHandler(_handler: unknown): void {}
}

class Window {
  static latest: Window | undefined;
  readonly session = new Session();
  readonly mainFrame = {};
  readonly listeners = new Map<string, (...args: any[]) => void>();
  transferred: ElectronMessagePortMainLike | undefined;
  destroyed = false;
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
    setWindowOpenHandler: (_handler: () => { action: "deny" }) => undefined,
    postMessage: (channel: string, message: unknown, transfer?: readonly ElectronMessagePortMainLike[]) => {
      this.transferred = transfer?.[0];
      if (channel === "yplusplus:plugin-connect") {
        ipc.emit("yplusplus:plugin-bridge-ready", {
          sender: this.webContents,
          senderFrame: this.mainFrame,
        }, (message as { nonce: string }).nonce);
      }
    },
    executeJavaScript: async (_code: string) => {
      this.transferred?.postMessage({
        rpcVersion: 1,
        type: "request",
        requestId: "integration-1",
        method: "capabilities.notifications.show",
        payload: { title: "Y++ integration", message: "Notification adapter reached." },
      });
      return true;
    },
    isDestroyed: () => this.destroyed,
  };
  constructor(_options: unknown) { Window.latest = this; }
  once(event: "closed", listener: () => void): this { this.listeners.set(event, listener); return this; }
  async loadFile(_filePath: string): Promise<void> {}
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.get("closed")?.();
  }
  isDestroyed(): boolean { return this.destroyed; }
}

const ipc = new IpcMain();

function plugin(directory: string): ManagedPlugin {
  return {
    id: "dev.example.notification",
    name: "Notification Example",
    version: "1.0.0",
    directory,
    state: "READY",
    requestedPermissions: ["ui.notifications"],
    approvedPermissions: ["ui.notifications"],
    deniedPermissions: [],
    compatibility: { compatible: true, pluginApiVersion: 1, hostApiVersion: 1 },
  };
}

test("Electron runtime host connects MessageChannel, capability broker, and native notifications", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "yplusplus-electron-host-"));
  let notificationShown!: () => void;
  const shown = new Promise<void>((resolve) => { notificationShown = resolve; });
  const notifications: Array<{ title: string; body: string }> = [];

  class Notification {
    constructor(readonly value: { title: string; body: string }) {}
    show(): void {
      notifications.push(this.value);
      notificationShown();
    }
  }

  await writeFile(path.join(directory, "yplusplus.plugin.json"), JSON.stringify({
    manifestVersion: 1,
    id: "dev.example.notification",
    name: "Notification Example",
    version: "1.0.0",
    description: "integration test",
    apiVersion: 1,
    entry: "index.js",
    permissions: ["ui.notifications"],
  }));
  await writeFile(path.join(directory, "index.js"), "export async function activate() {}");

  try {
    const options: ElectronPluginRuntimeHostOptions = {
      BrowserWindow: Window as unknown as ElectronPluginExecutionOptions["BrowserWindow"],
      ipcMain: ipc as unknown as ElectronPluginExecutionOptions["ipcMain"],
      MessageChannelMain: Channel,
      Notification,
      getApprovedPermissions: async () => new Set(["ui.notifications"]),
      isSandboxDisabled: () => false,
      preloadPath: "/runtime/plugin-preload.cjs",
      bootstrapHtmlPath: "/runtime/plugin-host.html",
    };
    const host = createElectronPluginRuntimeHost(options);
    const started = await host.start(plugin(directory));
    assert.equal(started.state, "ACTIVE");
    await shown;
    assert.deepEqual(notifications, [{
      title: "Y++ integration",
      body: "Notification adapter reached.",
    }]);
    await host.unload("dev.example.notification");
    assert.equal(host.get("dev.example.notification")?.state, "UNLOADED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("sandbox detection catches both Electron commandLine and process argv switches", () => {
  assert.equal(isElectronSandboxDisabled({ commandLine: { hasSwitch: () => true } }, []), true);
  assert.equal(isElectronSandboxDisabled({ commandLine: { hasSwitch: () => false } }, ["/app", "--no-sandbox"]), true);
  assert.equal(isElectronSandboxDisabled({ commandLine: { hasSwitch: () => false } }, ["/app"]), false);
});
