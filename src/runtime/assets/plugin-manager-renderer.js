"use strict";

const api = window.yplusplusPluginManager;
const pluginsRoot = document.getElementById("plugins");
const notice = document.getElementById("notice");
const summary = document.getElementById("summary");
const rejectedSection = document.getElementById("rejected-section");
const rejectedRoot = document.getElementById("rejected");

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function button(label, action, variant = "secondary") {
  const node = element("button", "button " + variant, label);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function setBusy(busy) {
  document.querySelectorAll("button").forEach((item) => { item.disabled = busy; });
}

async function perform(task) {
  notice.textContent = "";
  setBusy(true);
  try {
    await task();
    await refresh();
  } catch (error) {
    notice.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setBusy(false);
  }
}

function renderPlugin(plugin) {
  const card = element("article", "plugin");
  const head = element("div", "plugin-head");
  const identity = element("div", "plugin-title");
  identity.append(element("div", "plugin-icon", "◇"));
  const names = element("div");
  names.append(element("h2", "", plugin.name));
  names.append(element("div", "plugin-id", plugin.id));
  identity.append(names);
  const status = element("span", "state " + String(plugin.state).toLowerCase(), plugin.runtimeState === "ACTIVE" ? "ACTIVE" : plugin.state.replaceAll("_", " "));
  head.append(identity, status);
  card.append(head, element("p", "plugin-desc", "Version " + plugin.version + " · API " + plugin.compatibility.pluginApiVersion));

  const permissionArea = element("div");
  permissionArea.append(element("div", "section-label", "Capabilities"));
  const permissionList = element("div", "permissions");
  if (!plugin.requestedPermissions.length) {
    permissionList.append(element("div", "permission", "This plugin requests no capabilities."));
  }
  for (const capability of plugin.requestedPermissions) {
    const row = element("div", "permission");
    const name = element("span", "permission-name", capability);
    const approved = plugin.approvedPermissions.includes(capability);
    const state = element("span", "permission-state", approved ? "Approved" : "Not approved");
    row.append(name, state);
    permissionList.append(row);
  }
  permissionArea.append(permissionList);
  card.append(permissionArea);

  const actions = element("div", "actions");
  if (!plugin.trusted) {
    actions.append(button("Trust release", () => perform(() => api.trust(plugin.id, plugin.version)), "primary"));
  } else {
    actions.append(button("Revoke trust", () => perform(() => api.untrust(plugin.id, plugin.version)), "danger"));
  }
  const pending = plugin.requestedPermissions.filter((item) => !plugin.approvedPermissions.includes(item));
  if (plugin.trusted && pending.length) {
    actions.append(button("Approve requested capabilities", () => perform(() => api.approve(plugin.id, plugin.version, pending)), "primary"));
  }
  if (plugin.approvedPermissions.length) {
    actions.append(button("Revoke all capabilities", () => perform(() => api.revoke(plugin.id, plugin.version)), "danger"));
  }
  if (plugin.runtimeState === "ACTIVE") {
    actions.append(button("Stop plugin", () => perform(() => api.unload(plugin.id, plugin.version))));
  }
  card.append(actions);
  if (plugin.issue) card.append(element("p", "plugin-desc", plugin.issue.message));
  return card;
}

async function refresh() {
  const result = await api.refresh();
  pluginsRoot.replaceChildren();
  summary.textContent = result.plugins.length + " installed · " +
    result.plugins.filter((item) => item.runtimeState === "ACTIVE").length + " running";
  if (!result.plugins.length) {
    pluginsRoot.append(element("div", "empty", "No plugins found. Add a plugin to your Y++ plugins directory to get started."));
  } else {
    for (const plugin of result.plugins) pluginsRoot.append(renderPlugin(plugin));
  }
  rejectedRoot.replaceChildren();
  rejectedSection.hidden = result.rejected.length === 0;
  for (const item of result.rejected) {
    rejectedRoot.append(element("div", "rejected-item", item.directory + " — " + item.issues.map((issue) => issue.code).join(", ")));
  }
}

document.getElementById("refresh").addEventListener("click", () => {
  perform(async () => {});
});
refresh().catch((error) => { notice.textContent = error.message || String(error); });
