export const YPLUSPLUS_PRELOAD_SOURCE = `"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const ALLOWED_HOSTS = new Set([
  "www.yapper.website",
  "yapper.website",
  "www.yapin.gg",
  "yapin.gg"
]);
const VERSION = "0.1.0";
const CHANNELS = Object.freeze({
  snapshot: "yplusplus:settings-page:snapshot",
  get: "yplusplus:settings-page:get",
  set: "yplusplus:settings-page:set",
  enabled: "yplusplus:settings-page:enabled",
  fontImport: "yplusplus:settings-page:font-import",
  fontRemove: "yplusplus:settings-page:font-remove",
  fontSelect: "yplusplus:settings-page:font-select",
  fontActive: "yplusplus:settings-page:font-active"
});

try {
  const currentUrl = new URL(globalThis.location.href);
  const isAllowedOrigin =
    currentUrl.protocol === "https:" &&
    ALLOWED_HOSTS.has(currentUrl.hostname);

  if (process.isMainFrame && isAllowedOrigin) {
    const settingsPage = Object.freeze({
      refresh: () => ipcRenderer.invoke(CHANNELS.snapshot),
      get: (pluginId, panelId, itemId) =>
        ipcRenderer.invoke(CHANNELS.get, pluginId, panelId, itemId),
      set: async (pluginId, panelId, itemId, value) => {
        const result = await ipcRenderer.invoke(CHANNELS.set, pluginId, panelId, itemId, value);
        await applyActiveFont();
        return result;
      },
      setEnabled: async (pluginId, version, enabled) => {
        const result = await ipcRenderer.invoke(CHANNELS.enabled, pluginId, version, enabled);
        await applyActiveFont();
        return result;
      },
      importFont: (fileName, bytes) => ipcRenderer.invoke(CHANNELS.fontImport, fileName, bytes),
      removeFont: async (fontId) => {
        const result = await ipcRenderer.invoke(CHANNELS.fontRemove, fontId);
        await applyActiveFont();
        return result;
      },
      setActiveFont: async (fontId) => {
        const result = await ipcRenderer.invoke(CHANNELS.fontSelect, fontId);
        await applyActiveFont();
        return result;
      }
    });
    contextBridge.exposeInMainWorld("yplusplus", {
      version: VERSION,
      runtime: "yapper-desktop",
      ready: true,
      getStatus: () => ({
        ready: true,
        version: VERSION,
        origin: currentUrl.origin
      }),
      settingsPage
    });

    if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
    const element = (tag, className, value) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (value !== undefined) node.textContent = String(value);
      return node;
    };
    const icon = () => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "24");
      svg.setAttribute("height", "24");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "2");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M9 6V3h6v3m-9 0h12l1 14H5L6 6Zm3 4v6m6-6v6");
      svg.append(path);
      return svg;
    };

    let selected = false;
    let previousMain = null;
    let previousMainHidden = false;
    let currentModal = null;
    let navButton = null;
    let page = null;
    let refreshToken = 0;
    let appliedFontFace = null;
    let fontStyleSheet = null;
    let fontApplyToken = 0;

    const clearActiveFont = () => {
      if (appliedFontFace && document.fonts) document.fonts.delete(appliedFontFace);
      appliedFontFace = null;
      if (fontStyleSheet && document.adoptedStyleSheets) {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== fontStyleSheet);
      }
      fontStyleSheet = null;
      if (document.documentElement) document.documentElement.style.removeProperty("--yplusplus-font-family");
    };

    async function applyActiveFont() {
      const token = ++fontApplyToken;
      try {
        const font = await ipcRenderer.invoke(CHANNELS.fontActive);
        if (token !== fontApplyToken) return;
        if (!font || typeof FontFace === "undefined" || !document.fonts) {
          clearActiveFont();
          return;
        }
        const face = new FontFace(font.family, new Uint8Array(font.bytes).buffer);
        await face.load();
        if (token !== fontApplyToken) return;
        clearActiveFont();
        document.fonts.add(face);
        appliedFontFace = face;
        if (typeof CSSStyleSheet !== "undefined" && document.adoptedStyleSheets) {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync("body, body *, button, input, textarea, select, [role=button] { font-family: \"" +
            font.family + "\", sans-serif !important; }");
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
          fontStyleSheet = sheet;
        } else if (document.documentElement) {
          document.documentElement.style.setProperty("--yplusplus-font-family", "\"" + font.family + "\", sans-serif", "important");
        }
      } catch (error) {
        console.error("[Y++] Could not apply selected font:", error);
      }
    }

    const showPluginPage = async () => {
      if (selected && page && page.isConnected && !page.hidden) {
        await renderSettings();
        return;
      }
      selected = true;
      const modal = document.querySelector('.modal[aria-label="User settings"]');
      const nav = modal && modal.querySelector(".settings-nav");
      const main = modal && modal.querySelector(".settings-main");
      if (!nav || !main || !page) return;
      previousMain = main;
      previousMainHidden = main.hidden;
      main.hidden = true;
      page.hidden = false;
      for (const button of nav.querySelectorAll("button")) {
        button.classList.remove("active");
        button.removeAttribute("aria-current");
      }
      navButton.classList.add("active");
      navButton.setAttribute("aria-current", "page");
      await renderSettings();
    };

    const leavePluginPage = () => {
      if (!selected) return;
      selected = false;
      if (navButton) {
        navButton.classList.remove("active");
        navButton.removeAttribute("aria-current");
      }
      if (previousMain && previousMain.isConnected) previousMain.hidden = previousMainHidden;
      previousMain = null;
      if (page) page.hidden = true;
    };

    const settingControl = async (pluginId, panel, item) => {
      const field = element("div", "field");
      const label = element("label", "", item.label);
      const id = "yplusplus-setting-" + pluginId + "-" + panel.id + "-" + item.id;
      label.htmlFor = id;
      let control;
      const value = await settingsPage.get(pluginId, panel.id, item.id);
      if (item.type === "toggle") {
        control = element("input", ""); control.type = "checkbox"; control.checked = Boolean(value);
      } else if (item.type === "select") {
        control = element("select", "input");
        for (const option of item.options) {
          const optionNode = element("option", "", option.label);
          optionNode.value = option.value;
          control.append(optionNode);
        }
        control.value = String(value);
      } else {
        control = element("input", "input");
        control.type = item.type === "number" ? "number" : "text";
        if (item.type === "text") {
          if (item.placeholder) control.placeholder = item.placeholder;
          control.maxLength = item.maxLength || 8192;
        } else {
          if (item.min !== undefined) control.min = String(item.min);
          if (item.max !== undefined) control.max = String(item.max);
          if (item.step !== undefined) control.step = String(item.step);
        }
        control.value = String(value);
      }
      control.id = id;
      const status = element("span", "hint", item.description || "");
      control.addEventListener("change", async () => {
        control.disabled = true;
        try {
          const next = item.type === "toggle" ? control.checked :
            item.type === "number" ? Number(control.value) : control.value;
          await settingsPage.set(pluginId, panel.id, item.id, next);
          status.textContent = item.description || "Saved";
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "Unable to save setting.";
        } finally {
          control.disabled = false;
        }
      });
      field.append(label, control);
      field.append(status);
      return field;
    };

    const renderSettings = async () => {
      if (!page || !selected) return;
      const token = ++refreshToken;
      page.replaceChildren();
      const heading = element("h2", "", "Plugins");
      const intro = element("p", "hint", "Installed Y++ plugins and their settings.");
      const refresh = element("button", "btn small", "Refresh");
      refresh.type = "button";
      refresh.addEventListener("click", () => { void renderSettings(); });
      page.append(heading, intro, refresh);
      try {
        const snapshot = await settingsPage.refresh();
        if (token !== refreshToken || !selected || !page) return;
        const pluginsById = new Map(snapshot.plugins.map((plugin) => [plugin.id, plugin]));
        if (snapshot.plugins.length === 0) {
          page.append(element("div", "ss2-card", "No installed plugins found."));
        }
        for (const plugin of snapshot.plugins) {
          const group = element("div", "ss2-group");
          group.append(element("div", "ss2-section", plugin.name));
          const card = element("section", "ss2-card");
          const runtime = plugin.runtimeState === "ACTIVE" ? "Running" : plugin.state.replaceAll("_", " ");
          const summary = element("p", "hint", "Version " + plugin.version + " · " + runtime);
          card.append(summary);
          const panels = snapshot.panels.filter((entry) => entry.pluginId === plugin.id);
          if (panels.length === 0) card.append(element("p", "hint", "This plugin has no settings panels."));
          for (const entry of panels) {
            const panel = entry.panel;
            const panelTitle = element("div", "ss2-section", panel.title);
            card.append(panelTitle);
            if (panel.description) card.append(element("p", "hint", panel.description));
            for (const item of panel.items) {
              try {
                card.append(await settingControl(plugin.id, panel, item));
              } catch (error) {
                card.append(element("p", "hint", "Could not load " + item.label + ": " +
                  (error instanceof Error ? error.message : String(error))));
              }
              if (token !== refreshToken || !selected) return;
            }
          }
          group.append(card);
          page.append(group);
        }
        if (!pluginsById.size) return;
      } catch (error) {
        if (token === refreshToken) page.append(element("p", "hint",
          "Y++ settings are unavailable: " + (error instanceof Error ? error.message : String(error))));
      }
    };

    const ensureSettingsEntry = () => {
      const modal = document.querySelector('.modal[aria-label="User settings"]');
      const nav = modal && modal.querySelector(".settings-nav");
      const main = modal && modal.querySelector(".settings-main");
      const shell = main && main.parentElement;
      if (!modal || !nav || !main || !shell) {
        if (currentModal && !modal) leavePluginPage();
        currentModal = null;
        navButton = null;
        page = null;
        return;
      }
      currentModal = modal;
      if (!navButton || !navButton.isConnected || navButton.parentElement !== nav) {
        navButton = element("button", "yplusplus-settings-nav", "Plugins");
        navButton.type = "button";
        navButton.prepend(icon());
        navButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void showPluginPage();
        });
        const developer = Array.from(nav.querySelectorAll("button"))
          .find((button) => button.textContent.trim() === "Developer");
        nav.insertBefore(navButton, developer || null);
      }
      if (!page || !page.isConnected || page.parentElement !== shell) {
        page = element("section", "yplusplus-settings-content");
        page.hidden = true;
        page.style.flex = "1 1 0";
        page.style.minWidth = "0";
        page.style.overflowY = "auto";
        page.style.padding = "24px";
        const closeButton = modal.querySelector(".settings-close");
        shell.insertBefore(page, closeButton || null);
      }
      if (!nav.dataset.yplusplusBound) {
        nav.dataset.yplusplusBound = "true";
        nav.addEventListener("click", (event) => {
          const target = event.target;
          const clicked = target && target.closest ? target.closest("button") : null;
          if (clicked && clicked !== navButton) leavePluginPage();
        }, true);
      }
      if (selected && page.hidden) void showPluginPage();
    };

    const observer = new MutationObserver(() => ensureSettingsEntry());
    const start = () => {
      if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });
      ensureSettingsEntry();
      void applyActiveFont();
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
    }
  }
} catch (error) {
  console.error("[Y++] Preload initialization failed:", error);
}
`;
