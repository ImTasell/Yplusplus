/**
 * Sandboxed Y++ plugin preload.
 *
 * Only this narrow capability facade crosses context isolation. Never expose
 * ipcRenderer, Node globals, or the raw MessagePort to plugin page code.
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const CONNECT_CHANNEL = "yplusplus:plugin-connect";
const READY_CHANNEL = "yplusplus:plugin-bridge-ready";
const REQUEST_TIMEOUT_MS = 10000;
const MAX_PENDING = 32;

let connected = false;

ipcRenderer.on(CONNECT_CHANNEL, (event, payload) => {
  if (connected || !payload || typeof payload.nonce !== "string") return;
  const port = event.ports && event.ports[0];
  if (!port || typeof port.postMessage !== "function") return;
  connected = true;

  let nextId = 0;
  let closed = false;
  const pending = new Map();

  const onMessage = (messageEvent) => {
    const response = messageEvent.data;
    if (!response || response.rpcVersion !== 1 || response.type !== "response" ||
        typeof response.requestId !== "string" || typeof response.ok !== "boolean") return;
    const item = pending.get(response.requestId);
    if (!item) return;
    pending.delete(response.requestId);
    clearTimeout(item.timer);
    if (response.ok) item.resolve();
    else {
      const error = response.error && typeof response.error.message === "string"
        ? new Error(response.error.message)
        : new Error("Y++ capability request failed.");
      error.name = "PluginApiError";
      error.code = response.error && typeof response.error.code === "string"
        ? response.error.code
        : "INTERNAL_ERROR";
      item.reject(error);
    }
  };

  const request = (input) => {
    if (closed) return Promise.reject(new Error("The Y++ plugin session is closed."));
    if (pending.size >= MAX_PENDING) return Promise.reject(new Error("Too many pending Y++ API requests."));
    if (!input || typeof input.title !== "string" || typeof input.message !== "string") {
      return Promise.reject(new TypeError("Expected string title and message."));
    }
    const requestId = "p" + (++nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        const error = new Error("The Y++ host did not respond in time.");
        error.name = "PluginApiError";
        error.code = "REQUEST_TIMEOUT";
        reject(error);
      }, REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer });
      try {
        port.postMessage({
          rpcVersion: 1,
          type: "request",
          requestId,
          method: "capabilities.notifications.show",
          payload: { title: input.title, message: input.message }
        });
      } catch (_error) {
        pending.delete(requestId);
        clearTimeout(timer);
        reject(new Error("Could not send the Y++ API request."));
      }
    });
  };

  port.addEventListener("message", onMessage);
  port.start();

  const api = Object.freeze({
    notifications: Object.freeze({
      show: (input) => request(input)
    })
  });

  try {
    contextBridge.exposeInMainWorld("yplusplus", api);
    ipcRenderer.send(READY_CHANNEL, payload.nonce);
  } catch (_error) {
    closed = true;
    port.close();
  }
});
