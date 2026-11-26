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

    const styled = (node, values) => {
      Object.assign(node.style, values);
      return node;
    };

    const gearIcon = () => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("width", "18");
      svg.setAttribute("height", "18");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "2");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v2m0 16v2m10-10h-2M4 12H2m17.07-7.07-1.42 1.42M6.35 17.65l-1.42 1.42m14.14 0-1.42-1.42M6.35 6.35 4.93 4.93");
      svg.append(path);
      return svg;
    };

    const settingControl = async (pluginId, panel, item) => {
      const field = styled(element("div", "yplusplus-setting-field"), {
        display: "grid", gap: "6px", margin: "14px 0"
      });
      const label = element("label", "yplusplus-setting-label", item.label);
      const id = "yplusplus-setting-" + pluginId + "-" + panel.id + "-" + item.id;
      label.htmlFor = id;
      styled(label, { fontWeight: "600", fontSize: "13px" });
      let control;
      const value = await settingsPage.get(pluginId, panel.id, item.id);
      if (item.type === "toggle") {
        control = element("input", ""); control.type = "checkbox"; control.checked = Boolean(value);
        styled(control, { width: "18px", height: "18px", accentColor: "#aeb1ff" });
      } else if (item.type === "select") {
        control = element("select", "");
        for (const option of item.options) {
          const optionNode = element("option", "", option.label);
          optionNode.value = option.value;
          control.append(optionNode);
        }
        control.value = String(value);
      } else {
        control = element("input", "");
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
      styled(control, {
        maxWidth: "100%", padding: "9px 10px", borderRadius: "8px",
        border: "1px solid #454b5d", background: "#171a22", color: "inherit",
        font: "inherit"
      });
      const status = element("span", "yplusplus-setting-hint", item.description || "");
      styled(status, { opacity: "0.7", fontSize: "11px" });
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
      field.append(label, control, status);
      return field;
    };

    let activePopup = null;
    const closeSettingsPopup = () => {
      if (activePopup && activePopup.isConnected) activePopup.remove();
      activePopup = null;
    };

    const renderFontLibrary = (container, plugin, snapshot) => {
      const section = styled(element("section", "yplusplus-font-library"), {
        borderTop: "1px solid #3a4050", marginTop: "18px", paddingTop: "16px"
      });
      section.append(element("h3", "", "TrueType font library"));
      section.append(styled(element("p", "yplusplus-popup-hint",
        "Import .ttf files, then choose which font Yapin' should use. Files stay in your private Y++ data directory."),
      { fontSize: "12px", opacity: "0.72", lineHeight: "1.5" }));

      const input = element("input", "");
      input.type = "file";
      input.accept = ".ttf,font/ttf";
      input.hidden = true;
      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          await settingsPage.importFont(file.name, bytes);
          await openPluginSettings(plugin);
        } catch (error) {
          const message = element("p", "yplusplus-font-error",
            error instanceof Error ? error.message : "Unable to import this font.");
          styled(message, { color: "#ff9ea8", fontSize: "12px" });
          section.append(message);
        }
      });
      const importButton = element("button", "yplusplus-font-import", "Import TTF…");
      importButton.type = "button";
      styled(importButton, {
        border: "0", borderRadius: "8px", padding: "9px 12px", cursor: "pointer",
        background: "#c8caff", color: "#20223a", fontWeight: "700"
      });
      importButton.addEventListener("click", () => input.click());
      section.append(importButton, input);

      const list = styled(element("div", "yplusplus-font-list"), {
        display: "grid", gap: "8px", marginTop: "14px"
      });
      if (!snapshot.fonts.length) {
        list.append(styled(element("p", "yplusplus-popup-hint", "No TTF fonts imported yet."),
          { fontSize: "12px", opacity: "0.7" }));
      }
      for (const font of snapshot.fonts) {
        const row = styled(element("div", "yplusplus-font-row"), {
          display: "flex", alignItems: "center", gap: "8px", justifyContent: "space-between",
          padding: "10px", borderRadius: "9px", background: "#222631"
        });
        const name = styled(element("span", "", font.name), { fontSize: "13px", minWidth: "0", overflowWrap: "anywhere" });
        const actions = styled(element("div", ""), { display: "flex", gap: "6px", flexShrink: "0" });
        const useButton = element("button", "", font.active ? "Using" : "Use");
        useButton.type = "button";
        useButton.disabled = Boolean(font.active);
        styled(useButton, {
          border: "0", borderRadius: "7px", padding: "6px 9px",
          background: font.active ? "#31493e" : "#34394a", color: "inherit", cursor: "pointer"
        });
        useButton.addEventListener("click", async () => {
          try {
            await settingsPage.setActiveFont(font.id);
            await openPluginSettings(plugin);
          } catch (error) {
            useButton.title = error instanceof Error ? error.message : "Unable to select font.";
          }
        });
        const removeButton = element("button", "", "Remove");
        removeButton.type = "button";
        styled(removeButton, {
          border: "0", borderRadius: "7px", padding: "6px 9px",
          background: "#48272d", color: "#ffbdc4", cursor: "pointer"
        });
        removeButton.addEventListener("click", async () => {
          try {
            await settingsPage.removeFont(font.id);
            await openPluginSettings(plugin);
          } catch (error) {
            removeButton.title = error instanceof Error ? error.message : "Unable to remove font.";
          }
        });
        actions.append(useButton, removeButton);
        row.append(name, actions);
        list.append(row);
      }
      section.append(list);
      return section;
    };

    const openPluginSettings = async (plugin) => {
      closeSettingsPopup();
      const overlay = styled(element("div", "yplusplus-popup-overlay"), {
        position: "fixed", inset: "0", zIndex: "2147483000",
        display: "grid", placeItems: "center", padding: "24px",
        background: "rgba(5, 7, 12, 0.72)"
      });
      const panel = styled(element("section", "yplusplus-popup"), {
        width: "min(620px, 94vw)", maxHeight: "min(760px, 88vh)", overflowY: "auto",
        border: "1px solid #42485a", borderRadius: "16px", padding: "22px",
        background: "#1b1e28", color: "#f1f2f6", boxShadow: "0 24px 90px rgba(0,0,0,.5)"
      });
      const header = styled(element("div", ""), {
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px"
      });
      header.append(element("h2", "", plugin.name + " settings"));
      const close = element("button", "", "✕");
      close.type = "button";
      close.setAttribute("aria-label", "Close plugin settings");
      styled(close, { border: "0", background: "transparent", color: "inherit", fontSize: "20px", cursor: "pointer" });
      close.addEventListener("click", closeSettingsPopup);
      header.append(close);
      panel.append(header);
      const loading = styled(element("p", "", "Loading settings…"), { fontSize: "12px", opacity: "0.7" });
      panel.append(loading);
      overlay.append(panel);
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeSettingsPopup();
      });
      document.body.append(overlay);
      activePopup = overlay;

      try {
        const snapshot = await settingsPage.refresh();
        if (activePopup !== overlay) return;
        loading.remove();
        const panels = snapshot.panels.filter((entry) => entry.pluginId === plugin.id);
        for (const entry of panels) {
          const definition = entry.panel;
          panel.append(element("h3", "", definition.title));
          if (definition.description) {
            panel.append(styled(element("p", "yplusplus-popup-hint", definition.description),
              { fontSize: "12px", opacity: "0.72", lineHeight: "1.5" }));
          }
          for (const item of definition.items) {
            try {
              panel.append(await settingControl(plugin.id, definition, item));
            } catch (error) {
              panel.append(styled(element("p", "", "Could not load " + item.label + ": " +
                (error instanceof Error ? error.message : String(error))),
              { color: "#ff9ea8", fontSize: "12px" }));
            }
            if (activePopup !== overlay) return;
          }
        }
        if (plugin.id === "dev.yplusplus.fonts") {
          panel.append(renderFontLibrary(panel, plugin, snapshot));
        } else if (!panels.length) {
          panel.append(styled(element("p", "", plugin.trusted ?
            "This plugin has no registered settings panels yet." :
            "Trust this plugin in the Y++ Plugin Manager before its settings become available."),
          { fontSize: "12px", opacity: "0.72" }));
        }
      } catch (error) {
        if (activePopup === overlay) {
          panel.append(styled(element("p", "", error instanceof Error ? error.message : "Unable to load plugin settings."),
            { color: "#ff9ea8", fontSize: "12px" }));
        }
      }
    };

    const renderPluginCard = (plugin, snapshot) => {
      const card = styled(element("article", "yplusplus-plugin-card"), {
        border: "1px solid #3c4252", borderRadius: "12px", padding: "14px",
        background: "#20232d", marginTop: "12px"
      });
      const row = styled(element("div", "yplusplus-plugin-row"), {
        display: "flex", alignItems: "center", gap: "12px"
      });
      const details = styled(element("div", "yplusplus-plugin-details"), { flex: "1", minWidth: "0" });
      details.append(styled(element("div", "yplusplus-plugin-name", plugin.name),
        { fontSize: "14px", fontWeight: "700" }));
      details.append(styled(element("div", "yplusplus-plugin-description",
        "v" + plugin.version + " · " + (plugin.runtimeState === "ACTIVE" ? "Running" :
          !plugin.trusted ? "Trust required" :
          plugin.state === "WAITING_FOR_APPROVAL" ? "Permission approval required" :
          plugin.enabled ? plugin.state.replaceAll("_", " ") : "Disabled")),
      { fontSize: "11px", opacity: "0.68", marginTop: "4px" }));

      const switchLabel = styled(element("label", "yplusplus-switch"), {
        display: "inline-flex", alignItems: "center", gap: "7px", cursor: "pointer",
        fontSize: "11px", whiteSpace: "nowrap"
      });
      const toggle = element("input", "");
      toggle.type = "checkbox";
      toggle.checked = Boolean(plugin.enabled);
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-label", "Enable " + plugin.name);
      styled(toggle, { width: "18px", height: "18px", accentColor: "#aeb1ff", cursor: "pointer" });
      toggle.addEventListener("change", async () => {
        toggle.disabled = true;
        try {
          await settingsPage.setEnabled(plugin.id, plugin.version, toggle.checked);
          await renderSettings();
        } catch (error) {
          toggle.checked = Boolean(plugin.enabled);
          toggle.title = error instanceof Error ? error.message : "Unable to change plugin state.";
        } finally {
          toggle.disabled = false;
        }
      });
      switchLabel.append(toggle, element("span", "", plugin.enabled ? "On" : "Off"));

      const gear = element("button", "yplusplus-plugin-gear");
      gear.type = "button";
      gear.title = "Configure " + plugin.name;
      gear.setAttribute("aria-label", "Configure " + plugin.name);
      styled(gear, {
        width: "34px", height: "34px", display: "grid", placeItems: "center",
        border: "1px solid #464c5d", borderRadius: "9px", background: "#2b2f3b",
        color: "inherit", cursor: "pointer"
      });
      gear.append(gearIcon());
      gear.addEventListener("click", () => { void openPluginSettings(plugin); });
      row.append(details, switchLabel, gear);
      card.append(row);
      return card;
    };

    const renderSettings = async () => {
      if (!page || !selected) return;
      const token = ++refreshToken;
      closeSettingsPopup();
      page.replaceChildren();
      const heading = element("h2", "", "Plugins");
      const intro = styled(element("p", "hint", "Enable extensions and use the gear button to configure each one."),
        { fontSize: "12px", opacity: "0.72" });
      const refresh = element("button", "btn small", "Refresh");
      refresh.type = "button";
      styled(refresh, { border: "0", borderRadius: "8px", padding: "8px 11px", background: "#34394a", color: "inherit", cursor: "pointer" });
      refresh.addEventListener("click", () => { void renderSettings(); });
      page.append(heading, intro, refresh);
      try {
        const snapshot = await settingsPage.refresh();
        if (token !== refreshToken || !selected || !page) return;
        if (snapshot.plugins.length === 0) {
          page.append(styled(element("div", "ss2-card", "No installed plugins found."),
            { padding: "18px", borderRadius: "10px", background: "#222631" }));
        }
        for (const plugin of snapshot.plugins) page.append(renderPluginCard(plugin, snapshot));
      } catch (error) {
        if (token === refreshToken) page.append(styled(element("p", "hint",
          "Y++ settings are unavailable: " + (error instanceof Error ? error.message : String(error))),
        { color: "#ff9ea8" }));
      }
    };

    const ensureSettingsEntry = () => {
      const modal = document.querySelector('.modal[aria-label="User settings"]');
      const nav = modal && modal.querySelector(".settings-nav");
      const main = modal && modal.querySelector(".settings-main");
      const shell = main && main.parentElement;
      if (!modal || !nav || !main || !shell) {
        if (currentModal && !modal) { leavePluginPage(); closeSettingsPopup(); }
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
