import type { AudioStore } from "../plugins/audio-store.js";

interface ApplicationWebContents {
  readonly mainFrame: unknown;
  isDestroyed(): boolean;
  send?(channel: string, ...args: unknown[]): void;
}
interface ApplicationIpcEvent {
  readonly sender: ApplicationWebContents;
  readonly senderFrame?: unknown;
}
interface ApplicationIpcMain {
  on(channel: string, listener: (event: ApplicationIpcEvent, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: ApplicationIpcEvent, ...args: unknown[]) => void): void;
}
export interface ApplicationEventsIpcOptions {
  readonly ipcMain: ApplicationIpcMain;
  readonly onApplicationReady: (timestamp: number) => void;
  readonly audio: AudioStore;
}
const READY_CHANNEL = "yplusplus:application:ready";
const PLAY_CHANNEL = "yplusplus:audio:play";
const ALLOWED_HOSTS = new Set(["www.yapper.website", "yapper.website", "www.yapin.gg", "yapin.gg"]);

function isAllowedMainFrame(event: ApplicationIpcEvent): boolean {
  if (event.sender.isDestroyed() || !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame || typeof event.senderFrame !== "object" ||
      !("url" in event.senderFrame) || typeof event.senderFrame.url !== "string") return false;
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
  let startupAudioDispatched = false;
  const signalled = new WeakSet<ApplicationWebContents>();
  const onReady = (event: ApplicationIpcEvent): void => {
    if (!isAllowedMainFrame(event) || signalled.has(event.sender)) return;
    signalled.add(event.sender);
    readySenders.add(event.sender);
    options.onApplicationReady(Date.now());
  };
  options.ipcMain.on(READY_CHANNEL, onReady);
  return Object.freeze({
    async playStartupAudio(plugin) {
      if (plugin.id !== "dev.yplusplus.hello") throw new Error("Only the Hello! plugin can request startup audio.");
      if (startupAudioDispatched) return;
      const active = await options.audio.getActive();
      if (!active) return;
      startupAudioDispatched = true;
      for (const sender of [...readySenders]) {
        if (sender.isDestroyed()) { readySenders.delete(sender); continue; }
        if (typeof sender.send !== "function") continue;
        try {
          sender.send(PLAY_CHANNEL, Object.freeze({
            bytes: active.bytes,
            mimeType: active.mimeType,
          }));
        } catch {
          readySenders.delete(sender);
        }
      }
    },
    dispose() {
      options.ipcMain.removeListener(READY_CHANNEL, onReady);
      readySenders.clear();
    },
  });
}
