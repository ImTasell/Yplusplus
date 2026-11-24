"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const api = Object.freeze({
  refresh: () => invoke("yplusplus:manager:refresh"),
  trust: (id, version) => invoke("yplusplus:manager:trust", id, version),
  untrust: (id, version) => invoke("yplusplus:manager:untrust", id, version),
  approve: (id, version, capabilities) => invoke("yplusplus:manager:approve", id, version, capabilities),
  revoke: (id, version, capabilities) => invoke("yplusplus:manager:revoke", id, version, capabilities),
  unload: (id, version) => invoke("yplusplus:manager:unload", id, version)
});

contextBridge.exposeInMainWorld("yplusplusPluginManager", api);
