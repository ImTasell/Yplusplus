import type { AudioStore } from "../plugins/audio-store.js";
import type { PluginRuntimeHost } from "./host.js";

interface ApplicationFrame { readonly url?: string; }
interface ApplicationWebContents {
  readonly mainFrame: unknown;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}
interface ApplicationIpcEvent {
  readonly sender: ApplicationWebContents;
  readonly senderFrame?: ApplicationFrame | null;
}
interface ApplicationIpcMain {
  on(channel: string, listener: (event: ApplicationIpcEvent, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: ApplicationIpcEvent, ...args: unknown[]) => void): void;
}
export interface ApplicationEventsIpcOptions {
  readonly ipcMain: ApplicationIpcMain;
  readonly runtime: PluginRuntimeHost;
  readonly audio: AudioStore;
}
const READY_CHANNEL = "yplusplus:application:ready";
const PLAY_CHANNEL = "yplusplus:audio:play";
const ALLOWED_HOSTS = new Set(["www.yapper.website", "yapper.website", "www.yapin.gg", "yapin.gg"]);

function isAllowedMainFrame(event: ApplicationIpcEvent): boolean {
  if (event.sender.isDestroyed() || !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame || typeof event.senderFrame.url !== "string") return false;
  try {
    const url = new URL(event.senderFrame.url);
    return url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname);
  } catch { return false; }
}

/** Bridges one authenticated app-ready signal and one fixed audio playback action. */
export function installApplicationEventsIpc(options: ApplicationEventsIpcOptions): Readonly<{
  playStartupAudio(plugin: Readonly<{ id: string; version: string }>): Promise<void>;
  dispose(): void;
}> {
  const readySenders = new Set<ApplicationWebContents>();
  const signalled = new WeakSet<ApplicationWebContents>();
  const onReady = (event: ApplicationIpcEvent): void => {
    if (!isAllowedMainFrame(event) || signalled.has(event.sender)) return;
    signalled.add(event.sender);
    readySenders.add(event.sender);
    options.runtime.emitApplicationReady(Date.now());
  };
  options.ipcMain.on(READY_CHANNEL, onReady);
  return Object.freeze({
    async playStartupAudio(plugin) {
      if (plugin.id !== "dev.yplusplus.hello") throw new Error("Only the Hello! plugin can request startup audio.");
      const active = await options.audio.getActive();
      if (!active) return;
      for (const sender of [...readySenders]) {
        if (sender.isDestroyed()) { readySenders.delete(sender); continue; }
        sender.send(PLAY_CHANNEL, Object.freeze({
          bytes: active.bytes,
          mimeType: active.mimeType,
        }));
      }
    },
    dispose() {
      options.ipcMain.removeListener(READY_CHANNEL, onReady);
      readySenders.clear();
    },
  });
}
