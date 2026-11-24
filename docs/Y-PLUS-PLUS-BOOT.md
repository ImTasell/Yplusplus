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

Requires Node.js 20.11 or newer. Node 22.16+ can run the TypeScript source directly using built-in type stripping.

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

A one-time GitHub Actions integration run extracted the captured official 1.2.7 AppImage, inspected its real ASAR, patched it successfully, verified the patch marker, restored the backup, and compared the restored archive byte-for-byte with the original. The temporary integration job was removed after that check.

## Known limitations

- The real AppImage archive patch/restore path and ASAR integrity metadata have been verified in GitHub Actions; this does not yet prove the preload executes inside a live Yapper window.
- The preload script is a self-contained sandbox-compatible CommonJS file.
- Live graphical preload execution has not yet been validated.
- A successful patch is not a guarantee of compatibility with any Yapper version other than 1.2.7.
- The session registration API does not rerun for in-page navigations; the preload is injected for each matching document navigation.
- The Y++ API is not a plugin security sandbox. Plugin execution and capability brokering are future milestones.

## Next verification step

Run a patched extracted AppDir in a graphical Linux session and confirm:

1. Yapper opens normally.
2. `window.yapperDesktop` remains present.
3. `window.yplusplus` exists on the main Yapper page.
4. `window.yplusplus.getStatus()` reports ready.
5. External popups and non-Yapper pages do not receive the Y++ bridge.
6. Restoring the backup returns the original archive byte-for-byte.


## Current implementation status

The initial source implementation is committed. The patcher currently targets the verified Yapper 1.2.7 archive structure and writes a separate `yplusplus-preload.cjs` ASAR entry. Automated unit tests, type-check, and build now pass in CI. The real AppImage archive is undergoing a one-time patch/restore integration check before attempting a live graphical launch.


The next verification is a one-time headless Electron launch under Xvfb, using Chromium DevTools Protocol to inspect the live renderer and confirm both `window.yplusplus` and the original `window.yapperDesktop` bridge coexist.
