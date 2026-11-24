# Y++ BOOT

Y++ BOOT is the first experimental integration milestone for Yapper Desktop. It is intentionally a small, reversible proof-of-concept rather than the full plugin framework.

## Current target

- Yapper Desktop: **1.2.7**
- Electron: **45.2.1**
- Linux AppImage, extracted AppDir
- Main-process anchor: `const ses = session.defaultSession;`
- Existing preload: `preload.js` (preserved)

## Integration design

The Yapper main process already imports Electron's `session` module and obtains `session.defaultSession` during `app.whenReady()`. Y++ inserts a guarded registration immediately after that point:

```js
ses.registerPreloadScript({
  type: 'frame',
  id: 'yplusplus-runtime',
  filePath: path.join(__dirname, 'yplusplus-preload.cjs'),
  matches: [
    'https://www.yapper.website/*',
    'https://yapper.website/*',
    'https://www.yapin.gg/*',
    'https://yapin.gg/*'
  ]
});
```

Electron runs registered frame preloads before the WebContents' configured preload. The new preload is a separate ASAR root entry. It does not replace or edit Yapper's existing `preload.js`.

The preload has two additional checks: HTTPS plus the exact Yapper/Yapin host allowlist, and `process.isMainFrame`. Its initial API is deliberately tiny:

- `window.yplusplus.version`
- `window.yplusplus.runtime`
- `window.yplusplus.ready`
- `window.yplusplus.getStatus()`

It does not expose Node.js, `ipcRenderer`, filesystem access, or privileged operations.

### Origin-isolation regression coverage

The preload registration uses four exact HTTPS host patterns; it does not use a wildcard subdomain pattern. The preload independently checks the parsed document URL against the same four-host allowlist and refuses to expose the API unless `process.isMainFrame` is true. This means third-party OAuth pages (for example Google, Discord, GitHub, and Microsoft sign-in origins), lookalike domains, plain HTTP pages, and child frames are denied by the preload guard.

The automated tests execute the actual generated preload source in an isolated JavaScript VM with a mocked Electron `contextBridge`. They cover all four allowed origins, external sign-in hosts, lookalike hosts, HTTP, non-web/malformed URLs, and child frames. A separate patcher test asserts that the injected Electron URL filters remain the four exact host patterns and do not become wildcard subdomain filters.

**Scope note:** these are deterministic policy/regression tests, not a claim that every possible Yapper OAuth popup flow has been exercised in a live desktop session. The previous live Electron test verified the bridge and original Yapper bridge coexist in the main renderer. Live popup/navigation verification remains part of desktop smoke testing.

### Document lifecycle expectations

The registered preload is a document-start hook, not a navigation event listener:

- SPA `history.pushState()`, `replaceState()`, and fragment changes keep the existing document and its existing `window.yplusplus` object. The preload is not executed again.
- A same-origin full document navigation or reload creates a new document; the matching preload runs again and exposes a fresh bridge object.
- A top-level navigation or popup to a third-party origin creates a separate document context and is denied by the origin guard.
- Returning to an approved Yapper/Yapin origin through a new document navigation bootstraps the bridge again.

The navigation regression tests model those document-context boundaries while executing the actual preload source. They verify bridge persistence for same-document route changes, fresh bootstrap on reload, and denial on external navigation/popups. They do not replace an Electron-level test of Chromium's navigation lifecycle; that remains a useful final smoke test.

## Why the patcher edits the ASAR header

The patcher uses a small ASAR reader/writer implemented with Node built-ins. It appends the replacement main-process source and new preload to the archive's data section, then updates only their offsets, sizes, and SHA-256 integrity metadata. Existing file payloads—including the original preload and the unpacked native dependency directory—are left in place.

Before writing, it validates:

1. ASAR header structure and JSON.
2. Package name is exactly `yapper-desktop`.
3. Version is exactly `1.2.7`.
4. The main-process insertion anchor appears exactly once.
5. Existing ASAR integrity hashes for files being read.

The patcher creates `resources/app.asar.yplusplus-original` once and writes the patched archive atomically. Re-running the patch is idempotent. Restore copies the original archive back.

## Development

Requires Node.js 20.11 or newer and npm. The CLI runs through `tsx`; the production build is compiled with TypeScript.

```bash
npm install
npm test
npm run typecheck
npm run build
```

Extract the official AppImage using its own runtime:

```bash
mkdir -p /tmp/yapper-extract
cd /tmp/yapper-extract
/path/to/Yapper-Setup.AppImage --appimage-extract
```

Inspect and patch the extracted AppDir:

```bash
npm run inspect -- /tmp/yapper-extract/squashfs-root
npm run patch -- /tmp/yapper-extract/squashfs-root
```

Restore the original ASAR:

```bash
npm run restore -- /tmp/yapper-extract/squashfs-root
```

**The original AppImage is never modified.** The CLI operates on an extracted AppDir. It does not yet build a replacement AppImage or install a desktop launcher.

Launch a patched AppDir through Y++ rather than running its `AppRun` script:

```bash
npm run launch -- /tmp/yapper-extract/squashfs-root
```

Y++ starts the Electron binary directly and recreates the AppRun library environment. It intentionally removes `APPIMAGE` from the child environment. The packaged `electron-updater` uses `APPIMAGE` as the path it unlinks and replaces during an update; AppRun sets that variable to itself when running an extracted AppDir. Leaving it unset prevents Yapper's updater from replacing the AppRun script or bypassing Y++ with an unpatched restart. As a consequence, Yapper's built-in AppImage updater is inactive under this launcher. Y++ must implement version detection, download, extraction, patching, and relaunch before automatic updates can be restored.

One GitHub Actions integration run extracted the captured official 1.2.7 AppImage, inspected its real ASAR, patched it successfully, verified the patch marker, restored the backup, and compared the restored archive byte-for-byte with the original. A second headless Electron integration run launched the patched AppDir under Xvfb and queried the live renderer over Chromium DevTools Protocol. It confirmed `window.yplusplus` (`version: 0.1.0`, `ready: true`) and the original `window.yapperDesktop` were both present. The temporary integration job was removed after verification.

## Known limitations

- The real AppImage archive patch/restore path and live renderer bridge have been verified on an Ubuntu Xvfb runner; Fedora/KDE desktop behavior still needs a local smoke test.
- The preload script is a self-contained sandbox-compatible CommonJS file.
- Yapper's built-in AppImage updater is intentionally inactive under the Y++ launcher. Y++ update management is not implemented yet.
- A successful patch is not a guarantee of compatibility with any Yapper version other than 1.2.7.
- The session registration API does not rerun for in-page navigations; it runs on matching document navigations.
- The Y++ API is not a plugin security sandbox. Plugin execution and capability brokering are future milestones.

## Next verification step

1. Verify that external sign-in popups and unrelated pages never receive the Y++ bridge.
2. Test reloads and same-origin navigation behavior.
3. Build a managed installation path and desktop launcher that can safely reapply patches after Yapper updates.
4. Implement Y++-managed update checks before re-enabling automatic updates.
5. Run a local Fedora/KDE smoke test.

