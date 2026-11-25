/**
 * Sandboxed Y++ plugin preload.
 *
 * Exposes a narrow capability API through contextBridge. The raw MessagePort,
 * ipcRenderer, Node globals, and host storage never cross context isolation.
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const CONNECT_CHANNEL = "yplusplus:plugin-connect";
const READY_CHANNEL = "yplusplus:plugin-bridge-ready";
const REQUEST_TIMEOUT_MS = 10000;
const MAX_PENDING = 32;
const SETTING_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
let connected = false;

ipcRenderer.on(CONNECT_CHANNEL, (event, payload) => {
  if (connected || !payload || typeof payload.nonce !== "string") return;
  const port = event.ports && event.ports[0];
  if (!port || typeof port.postMessage !== "function") return;
  connected = true;

  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const listeners = new Map();
  const subscribed = new Set();

  const validKey = (key) => {
    if (typeof key !== "string" || !SETTING_KEY.test(key)) {
      throw new TypeError("Invalid Y++ setting key.");
    }
  };
  const request = (method, payload) => {
    if (closed) return Promise.reject(new Error("The Y++ plugin session is closed."));
    if (pending.size >= MAX_PENDING) return Promise.reject(new Error("Too many pending Y++ API requests."));
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
        port.postMessage({ rpcVersion: 1, type: "request", requestId, method, payload });
      } catch (_error) {
        pending.delete(requestId);
        clearTimeout(timer);
        reject(new Error("Could not send the Y++ API request."));
      }
    });
  };

  const onMessage = (messageEvent) => {
    const message = messageEvent.data;
    if (!message || message.rpcVersion !== 1) return;
    if (message.type === "response" && typeof message.requestId === "string" && typeof message.ok === "boolean") {
      const item = pending.get(message.requestId);
      if (!item) return;
      pending.delete(message.requestId);
      clearTimeout(item.timer);
      if (message.ok) item.resolve(message.result);
      else {
        const error = message.error && typeof message.error.message === "string"
          ? new Error(message.error.message) : new Error("Y++ API request failed.");
        error.name = "PluginApiError";
        error.code = message.error && typeof message.error.code === "string"
          ? message.error.code : "INTERNAL_ERROR";
        item.reject(error);
      }
      return;
    }
    if (message.type === "event" && message.event === "settings.change" &&
        message.payload && typeof message.payload.key === "string" &&
        (typeof message.payload.value === "string" || typeof message.payload.value === "boolean" ||
          (typeof message.payload.value === "number" && Number.isFinite(message.payload.value)))) {
      const callbacks = listeners.get(message.payload.key);
      for (const callback of Array.from(callbacks || [])) {
        try { callback(message.payload.value); } catch (_error) { /* isolate plugin listener errors */ }
      }
    }
  };

  const subscribe = (key) => request("settings.subscribe", { key }).then(() => {
    subscribed.add(key);
    if (!listeners.has(key) && !closed) {
      subscribed.delete(key);
      return request("settings.unsubscribe", { key }).catch(() => undefined);
    }
  });
  const onChange = (key, listener) => {
    validKey(key);
    if (typeof listener !== "function") throw new TypeError("A settings listener is required.");
    let callbacks = listeners.get(key);
    if (!callbacks) { callbacks = new Set(); listeners.set(key, callbacks); }
    callbacks.add(listener);
    if (callbacks.size === 1) {
      void subscribe(key).catch(() => {
        callbacks.delete(listener);
        if (callbacks.size === 0) listeners.delete(key);
      });
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = listeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        listeners.delete(key);
        if (subscribed.delete(key) && !closed) {
          void request("settings.unsubscribe", { key }).catch(() => undefined);
        }
      }
    };
  };

  const onClose = () => {
    if (closed) return;
    closed = true;
    port.removeEventListener("message", onMessage);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("The Y++ plugin session is closed."));
    }
    pending.clear();
    listeners.clear();
    subscribed.clear();
  };

  port.addEventListener("message", onMessage);
  port.addEventListener("close", onClose);
  port.start();

  const api = Object.freeze({
    notifications: Object.freeze({
      show: (input) => {
        if (!input || typeof input.title !== "string" || typeof input.message !== "string") {
          return Promise.reject(new TypeError("Expected string title and message."));
        }
        return request("capabilities.notifications.show", {
          title: input.title, message: input.message
        }).then(() => undefined);
      }
    }),
    settings: Object.freeze({
      get: (key, defaultValue) => {
        validKey(key);
        if (typeof defaultValue !== "string" && typeof defaultValue !== "boolean" &&
            !(typeof defaultValue === "number" && Number.isFinite(defaultValue))) {
          return Promise.reject(new TypeError("Settings defaults must be strings, finite numbers, or booleans."));
        }
        return request("settings.get", { key, defaultValue });
      },
      set: (key, value) => {
        validKey(key);
        if (typeof value !== "string" && typeof value !== "boolean" &&
            !(typeof value === "number" && Number.isFinite(value))) {
          return Promise.reject(new TypeError("Settings values must be strings, finite numbers, or booleans."));
        }
        return request("settings.set", { key, value }).then(() => undefined);
      },
      onChange
    })
  });

  try {
    contextBridge.exposeInMainWorld("yplusplus", api);
    ipcRenderer.send(READY_CHANNEL, payload.nonce);
  } catch (_error) {
    onClose();
    port.close();
  }
});
