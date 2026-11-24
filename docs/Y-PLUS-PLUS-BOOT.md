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
node --experimental-strip-types src/cli.ts inspect /tmp/yapper-extract/squashfs-root
node --experimental-strip-types src/cli.ts patch /tmp/yapper-extract/squashfs-root
```

Restore the original ASAR:

```bash
node --experimental-strip-types src/cli.ts restore /tmp/yapper-extract/squashfs-root
```

**The original AppImage is never modified.** The current CLI only operates on an extracted AppDir. It does not yet build a replacement AppImage or install a desktop launcher.

## Known limitations

- This proves patch construction and archive integrity; it does not yet prove the preload executes inside a live Yapper window.
- The preload script must be bundled as a sandbox-compatible single file. The current emitted source is self-contained.
- AppImage updater behavior has not been validated. Do not use this patched AppDir as a daily driver until update behavior and rollback are tested.
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

The initial source implementation is committed. The patcher currently targets the verified Yapper 1.2.7 archive structure and writes a separate `yplusplus-preload.cjs` ASAR entry. Automated unit tests and a CI type-check/build are being brought online before attempting a live graphical launch.
