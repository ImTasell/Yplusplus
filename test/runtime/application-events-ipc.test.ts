import assert from "node:assert/strict";
import test from "node:test";
import { installApplicationEventsIpc } from "../../src/runtime/application-events-ipc.js";

class FakeIpcMain {
  readonly listeners = new Map<string, (event: any, ...args: unknown[]) => void>();
  on(channel: string, listener: (event: any, ...args: unknown[]) => void): void { this.listeners.set(channel, listener); }
  removeListener(channel: string, listener: (event: any, ...args: unknown[]) => void): void {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }
  emit(channel: string, event: any): void { this.listeners.get(channel)?.(event); }
}
function webContents(url: string) {
  const mainFrame = { url };
  const messages: Array<{ channel: string; args: unknown[] }> = [];
  let destroyed = false;
  return {
    mainFrame,
    messages,
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true; },
    send: (channel: string, ...args: unknown[]) => messages.push({ channel, args }),
  };
}

test("application-ready IPC validates the main frame and only signals each renderer once", async () => {
  const ipc = new FakeIpcMain();
  const timestamps: number[] = [];
  const runtime = { emitApplicationReady: (timestamp: number) => timestamps.push(timestamp) };
  const audio = { getActive: async () => ({
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: "audio/mpeg",
  }) };
  const bridge = installApplicationEventsIpc({ ipcMain: ipc, runtime: runtime as never, audio: audio as never });
  const contents = webContents("https://yapper.website/home");
  const event = { sender: contents, senderFrame: contents.mainFrame };
  try {
    ipc.emit("yplusplus:application:ready", event);
    ipc.emit("yplusplus:application:ready", event);
    assert.equal(timestamps.length, 1);
    await bridge.playStartupAudio({ id: "dev.yplusplus.hello", version: "1.0.0" });
    assert.equal(contents.messages.length, 1);
    assert.equal(contents.messages[0]?.channel, "yplusplus:audio:play");
    const payload = contents.messages[0]?.args[0] as { bytes: Uint8Array; mimeType: string };
    assert.deepEqual(Array.from(payload.bytes), [1, 2, 3]);
    assert.equal(payload.mimeType, "audio/mpeg");
    await assert.rejects(bridge.playStartupAudio({ id: "dev.example.other", version: "1.0.0" }), /Only the Hello/);
    ipc.emit("yplusplus:application:ready", {
      sender: contents,
      senderFrame: { url: "https://yapper.website/home" },
    });
    assert.equal(timestamps.length, 1, "subframes cannot announce readiness");
  } finally {
    bridge.dispose();
    assert.equal(ipc.listeners.size, 0);
  }
});
