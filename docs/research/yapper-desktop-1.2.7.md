# Yapper Desktop AppImage Research (1.2.7)

**Status:** Initial binary inspection complete  
**Target:** Official Linux AppImage  
**Inspected:** 2026-11-24  
**Purpose:** Establish a verified Y++ integration strategy without guessing at Yapper's Electron internals.

## Artifact provenance

- Official download endpoint: `https://files.yapper.website/desktop/Yapper-Setup.AppImage`
- Downloaded size: `126,372,436` bytes
- SHA-256: `db6d7f50c65f17ce1629beed93f6a538eb1ca56a73b8b710b8f32be2a0dba0bb`
- GitHub Actions artifact: `yapper-appimage-research` (artifact ID `14889420895`, one-day retention)
- AppImage runtime reports version/build identifier: `effcebc`
- The file is an x86-64 ELF AppImage. `--appimage-extract` succeeds and exposes a SquashFS AppDir.

The binary was retrieved through a temporary GitHub Actions workflow. The workflow was removed from the repository after the artifact was downloaded. The AppImage itself was not committed to Git.

## Verified application metadata

Read from `resources/app.asar/package.json` and Electron binary strings:

| Property | Value |
|---|---|
| Product | Yapper |
| Package name | `yapper-desktop` |
| Desktop app version | `1.2.7` |
| Electron | `45.2.1` |
| Chromium | `156.0.8078.75` |
| Main entry | `main.js` |
| App archive | `resources/app.asar` |
| Unpacked native dependency | `resources/app.asar.unpacked/node_modules/uiohook-napi` |

The app is a relatively small Electron shell around the remote Yapper website; it is not a self-contained bundled copy of the website frontend.

## Main renderer and existing preload

The main process creates its primary `BrowserWindow` in `main.js:createWindow()`.

Its web preferences are:

- `preload: path.join(__dirname, 'preload.js')`
- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`

The main window loads `https://www.yapper.website` through `loadSite()`. Navigation is restricted to the app's own approved hosts.

The existing `preload.js` exposes `window.yapperDesktop` through `contextBridge.exposeInMainWorld()`. It provides a deliberately narrow native API for badges, notifications, activity, screen sharing, updates, hotkeys, settings, titlebar state, focus, overlays, and window state.

**Y++ must not replace or mutate the existing `yapperDesktop` API.** It should expose a separate namespace such as `window.yplusplus`.

## The important discovery: Electron's session preload registry

The packaged Electron version is **45.2.1**. Electron provides:

```js
session.defaultSession.registerPreloadScript({
  type: 'frame',
  id: 'yplusplus-runtime',
  filePath: absolutePreloadPath,
  matches: [
    'https://www.yapper.website/*',
    'https://yapper.website/*',
    'https://www.yapin.gg/*',
    'https://yapin.gg/*'
  ]
});
```

Electron documents that registered frame preload scripts run before the preload configured in `webPreferences`, and that URL filters can constrain which documents receive them. This API was introduced in Electron 35, so it is available in the inspected Electron 45 runtime.

The Yapper main process already obtains `session.defaultSession` inside `app.whenReady()`. That is a clean, version-detectable registration point.

### Recommended integration shape

1. Y++ Bootstrap locates and identifies the installed Yapper AppImage.
2. It inspects the app version and verifies expected ASAR structure and source anchors.
3. It applies a minimal, idempotent patch to the packaged main-process entry so it registers a separate Y++ preload with `session.defaultSession.registerPreloadScript()`.
4. The Y++ preload is stored outside the original ASAR and bundled as a single sandbox-compatible script.
5. The Y++ preload checks `process.isMainFrame` and the exact allowed origin before initializing.
6. It exposes only a narrow `window.yplusplus` bridge with explicit methods. It never exposes `ipcRenderer`, Node.js, or unrestricted Electron objects.
7. The existing Yapper preload remains intact and continues to expose `window.yapperDesktop`.

The session registry is preferable to overwriting Yapper's own preload path: it was specifically designed to let third-party code register additional preloads without replacing existing ones.

## Important security and compatibility constraints

### Sandboxed preload constraints

Electron 45 sandboxed preloads have a deliberately reduced runtime. They can require Electron renderer modules, but cannot use arbitrary Node.js built-ins or load local npm packages with `require()`. Electron 45 also removed several old Node shims/globals from sandboxed preloads.

Therefore:

- Bundle the Y++ preload into one self-contained JavaScript file.
- Keep filesystem access and plugin discovery in the main process.
- Add narrowly scoped IPC handlers in the minimal main-process patch.
- Validate every IPC sender's frame URL and main-frame status.
- Validate payload schemas and capability grants in the main process.
- Treat third-party plugins as untrusted code. A worker is not automatically a security boundary if it can call a privileged bridge.

### URL scope

Yapper's main process defines these allowed page hosts:

- `www.yapper.website`
- `yapper.website`
- `www.yapin.gg`
- `yapin.gg`

The main process checks HTTPS and these hosts before loading the app page. The Y++ session preload should use the same exact allowlist, not a broad wildcard for all websites. Add a main-frame check as a second guard.

### Automatic updates

The packaged app includes `resources/app-update.yml` with a generic update provider at `https://www.yapper.website/download`.

The main process configures `electron-updater` to auto-download updates and install them on app quit. It checks shortly after startup and periodically thereafter.

This means a patch applied to one app version may disappear after an upstream update. Y++ Bootstrap must detect version changes, verify patch anchors, and reapply a compatible patch before launching. If the new version does not match the known structure, it must fail closed and launch unmodified Yapper rather than corrupting the app.

The exact Linux AppImage updater replacement behavior still needs a dedicated test. Do not assume the updater preserves an extracted or patched AppDir.

### AppImage filesystem

The AppImage is a read-only SquashFS container. Extraction produced:

- `AppRun`
- `yapper-desktop`
- `resources/app.asar`
- `resources/app.asar.unpacked/`

The unpacked `uiohook-napi` native module must be preserved when rebuilding or repacking the ASAR. A patcher must not accidentally pull native binaries into the archive or discard the unpacked directory.

### Avoid NODE_OPTIONS injection

Do not rely on `NODE_OPTIONS=--require=...` as the primary bootstrap. Electron documents that most `NODE_OPTIONS` flags are explicitly disallowed in packaged applications, except a small allowlist, and the `nodeOptions` fuse can disable the variable entirely.

## Recommended first implementation milestone: Y++ BOOT

Implement only enough to prove the integration:

- Detect AppImage and extracted-AppDir layouts.
- Read the ASAR header and package metadata safely.
- Identify the supported Yapper version and Electron major.
- Apply one reversible, idempotent main-process patch that registers the extra preload.
- Bundle a preload that exposes `window.yplusplus.version` and a small readiness signal.
- Confirm the original `window.yapperDesktop` remains available and unchanged.
- Confirm no Y++ preload runs on Google/Discord popups, external sites, or the local splash view.
- Log the detected version, patch status, preload registration result, and compatibility fingerprint.
- Roll back or launch stock Yapper if any integrity check fails.

Do not implement the full plugin manager, themes, or DevTools until this bootstrap works across a clean launch, reload, and app update.

## Open questions for the next research pass

1. Verify the exact Linux AppImage update replacement path and how it behaves when Yapper is launched through a Y++ wrapper.
2. Test `session.registerPreloadScript()` against this exact Electron 45.2.1 build, including ordering relative to Yapper's existing preload.
3. Determine whether the Y++ launcher should patch an extracted AppDir, create a derived AppImage, or use a managed per-version installation.
4. Confirm whether the official updater changes the AppImage in place, downloads a replacement, or relaunches through another path.
5. Establish an integrity/fingerprint strategy that detects upstream main-process changes without brittle blind text replacement.

## Reference documentation

- Electron preload scripts: https://www.electronjs.org/docs/latest/tutorial/tutorial-preload
- Electron session API: https://www.electronjs.org/docs/latest/api/session
- Electron preload script registration: https://www.electronjs.org/docs/latest/api/structures/preload-script
- Electron 45 release notes: https://www.electronjs.org/blog/electron-45-0
- Electron environment variables: https://www.electronjs.org/docs/latest/api/environment-variables/
- Electron fuses: https://www.electronjs.org/docs/latest/tutorial/fuses
