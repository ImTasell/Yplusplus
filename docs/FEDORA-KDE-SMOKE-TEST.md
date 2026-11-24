# Fedora KDE smoke test

This runbook verifies the managed Y++ install on a real Fedora desktop. It does not require root privileges.

## 1. Install

Use the Yapper AppImage you already downloaded; the installer does not copy or modify the source file.

From the Y++ repository root, in Fish:

```fish
node --version
npm install

set APPIMAGE "$HOME/Downloads/Yapper-Setup.AppImage"
chmod +x "$APPIMAGE"
npm run install-managed -- "$APPIMAGE"
```

The current patcher supports **Yapper 1.2.7 only**. If the AppImage is a different version, the command should fail closed and leave the source AppImage untouched. Do not force the patch.

Expected managed paths:

- AppDir: `~/.local/share/yplusplus/versions/yapper-desktop-1.2.7`
- Runtime: `~/.local/share/yplusplus/runtime/0.1.1`
- Desktop entry: `~/.local/share/applications/yplusplus-yapper.desktop`

## 2. Check the live update feed

```fish
set APPDIR "$HOME/.local/share/yplusplus/versions/yapper-desktop-1.2.7"
npm run check-updates -- "$APPDIR"
```

Record the installed/latest versions and whether Y++ reports the update as compatible. A newer unsupported version must be reported but must not be downloaded. Do not run `update-managed` unless the check reports that the version is supported.

## 3. Launch through Y++

Open **Yapper (Y++)** from KDE's application launcher. This uses the generated desktop entry and the managed Y++ runtime.

If the desktop entry has not appeared in the menu yet, launch directly from the repository:

```fish
node dist/cli.js launch "$APPDIR"
```

Confirm that:
- Yapper opens and renders the site.
- Login works, including Google/Discord OAuth popups.
- Voice, notifications, and other normal desktop features still work.
- Reloading with Ctrl+R does not break the app.
- Closing and reopening through the KDE launcher uses the managed version.

## 4. Optional bridge inspection

For a deeper check, close Yapper and start it with a local-only Chromium debugging port:

```fish
node dist/cli.js launch "$APPDIR" --remote-debugging-port=9222 '--remote-allow-origins=*'
```

Open `http://127.0.0.1:9222` in a browser, inspect the main Yapper page, and evaluate:

```js
({
  yplusplus: window.yplusplus?.version,
  ready: window.yplusplus?.ready,
  yapperDesktop: !!window.yapperDesktop
})
```

Expected on an approved Yapper page: `yplusplus: "0.1.0"`, `ready: true`, and `yapperDesktop: true`.

Inspect an external OAuth popup as a separate target if possible. It must not have `window.yplusplus`. Same-origin reloads should receive the bridge again. Close Yapper after the test to stop the debugging port.

## 5. If something fails

Run the launch command from a terminal so its output is visible:

```fish
node dist/cli.js launch "$APPDIR" --enable-logging
```

Send back:
- The full output of `npm run install-managed`
- The full output of `npm run check-updates`
- Any launch error or relevant terminal warnings
- Whether login popups, reload, and desktop relaunch worked

Do not use `sudo`, do not launch the extracted AppDir through `AppRun`, and do not set `APPIMAGE` manually. Y++ intentionally launches the Electron binary directly with a safe environment.
