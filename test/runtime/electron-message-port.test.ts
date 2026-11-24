import assert from "node:assert/strict";
import test from "node:test";
import {
  createElectronMessageChannel,
  getElectronTransferablePort,
  type ElectronMessagePortMainLike,
} from "../../src/runtime/electron-message-port.js";
import { bindRpcMessagePort } from "../../src/runtime/message-port.js";
import type { PluginRpcSession } from "../../src/runtime/rpc-session.js";

class FakeElectronPort implements ElectronMessagePortMainLike {
  peer?: FakeElectronPort;
  #listeners = new Set<(event: { readonly data: unknown }) => void>();
  closed = false;
  postMessage(message: unknown): void {
    if (this.closed || !this.peer || this.peer.closed) throw new Error("Port is closed.");
    for (const listener of this.peer.#listeners) {
      queueMicrotask(() => listener({ data: message }));
    }
  }
  on(_event: "message", listener: (event: { readonly data: unknown }) => void): this {
    this.#listeners.add(listener);
    return this;
  }
  off(_event: "message", listener: (event: { readonly data: unknown }) => void): this {
    this.#listeners.delete(listener);
    return this;
  }
  start(): void {}
  close(): void { this.closed = true; }
}

function fakeChannel() {
  const port1 = new FakeElectronPort();
  const port2 = new FakeElectronPort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

test("adapts Electron event-emitter ports to the host RPC transport", async () => {
  const native = fakeChannel();
  const channel = createElectronMessageChannel(() => native);
  const session = {
    dispatch: async (input: unknown) => ({
      rpcVersion: 1, type: "response", requestId: (input as { requestId: string }).requestId,
      ok: true, result: null,
    }),
  } as unknown as PluginRpcSession;
  const transport = bindRpcMessagePort(channel.hostPort, session);
  const response = new Promise<unknown>((resolve) => {
    channel.pluginPort.addEventListener("message", (event) => resolve(event.data));
    channel.pluginPort.start();
  });

  channel.pluginPort.postMessage({ requestId: "electron-port-test" });
  assert.deepEqual(await response, {
    rpcVersion: 1, type: "response", requestId: "electron-port-test",
    ok: true, result: null,
  });

  transport.close();
  assert.equal(native.port1.closed, true);
});

test("exposes only an adapter-owned native endpoint for transfer", () => {
  const native = fakeChannel();
  const channel = createElectronMessageChannel(() => native);
  assert.equal(getElectronTransferablePort(channel.pluginPort), native.port2);
  assert.throws(() => getElectronTransferablePort({
    postMessage() {},
    addEventListener() {},
    removeEventListener() {},
    start() {},
    close() {},
  }), /not an Electron MessagePortMain adapter/);
  channel.hostPort.close();
  channel.pluginPort.close();
});
