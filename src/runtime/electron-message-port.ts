/**
 * Electron MessagePortMain adapter.
 *
 * Electron's main-process ports use EventEmitter listeners, unlike DOM
 * MessagePorts. This wrapper gives the host RPC transport one consistent
 * interface while retaining the native port for transfer to a renderer.
 */
import type { PluginMessageChannel } from "./host.js";
import type { RpcMessagePort } from "./message-port.js";

export interface ElectronMessagePortMainLike {
  postMessage(message: unknown, transfer?: readonly ElectronMessagePortMainLike[]): void;
  on(event: "message", listener: (event: { readonly data: unknown }) => void): unknown;
  off(event: "message", listener: (event: { readonly data: unknown }) => void): unknown;
  start(): void;
  close(): void;
}

export interface ElectronMessageChannelMainLike {
  readonly port1: ElectronMessagePortMainLike;
  readonly port2: ElectronMessagePortMainLike;
}

export interface ElectronRpcMessagePort extends RpcMessagePort {
  /** Native Electron port; transfer this endpoint with webContents.postMessage. */
  readonly nativePort: ElectronMessagePortMainLike;
}

export class ElectronMessagePortAdapter implements ElectronRpcMessagePort {
  readonly nativePort: ElectronMessagePortMainLike;

  constructor(nativePort: ElectronMessagePortMainLike) {
    this.nativePort = nativePort;
  }

  postMessage(message: unknown): void {
    this.nativePort.postMessage(message);
  }

  addEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void {
    this.nativePort.on(type, listener);
  }

  removeEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void {
    this.nativePort.off(type, listener);
  }

  start(): void {
    this.nativePort.start();
  }

  close(): void {
    this.nativePort.close();
  }
}

/** Build a host/plugin channel using Electron's main-process MessageChannelMain. */
export function createElectronMessageChannel(
  createNativeChannel: () => ElectronMessageChannelMainLike,
): PluginMessageChannel {
  const channel = createNativeChannel();
  return Object.freeze({
    hostPort: new ElectronMessagePortAdapter(channel.port1),
    pluginPort: new ElectronMessagePortAdapter(channel.port2),
  });
}

/** Narrow the plugin endpoint before transferring it to a BrowserWindow. */
export function getElectronTransferablePort(
  port: RpcMessagePort,
): ElectronMessagePortMainLike {
  if (!(port instanceof ElectronMessagePortAdapter)) {
    throw new TypeError("The plugin endpoint is not an Electron MessagePortMain adapter.");
  }
  return port.nativePort;
}
