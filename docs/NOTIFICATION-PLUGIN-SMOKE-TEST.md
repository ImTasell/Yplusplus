# Y++ notification plugin smoke test

This test takes the checked-in example plugin through the real filesystem discovery, trust store, capability approval store, manager, and entry-point revalidation code. It does not execute third-party code inside a real Electron renderer; the final section is the manual desktop check.

## 1. Install the example plugin

Run these commands from the Y++ repository root in Fish:

```fish
set PLUGIN_ROOT "$HOME/.local/share/yplusplus/plugins"
mkdir -p "$PLUGIN_ROOT/notification-plugin"
cp -a examples/notification-plugin/. "$PLUGIN_ROOT/notification-plugin/"
```

If that destination already exists, inspect it before replacing it. The plugin requests only `ui.notifications`.

## 2. Confirm discovery (no execution yet)

```fish
npm run plugins -- list
```

Expected: `dev.example.notification@1.0.0` appears as `WAITING_FOR_TRUST` with `trusted=no`. Discovery and listing do not execute the plugin.

## 3. Trust this exact release

```fish
npm run plugins -- trust dev.example.notification 1.0.0
npm run plugins -- list
```

It should now report `WAITING_FOR_APPROVAL`. Trust allows this exact release to execute, but grants no APIs.

## 4. Approve its one requested capability

```fish
npm run plugins -- approve dev.example.notification 1.0.0 ui.notifications
npm run plugins -- list
```

Expected: `READY`, `trusted=yes`, and `capabilities=ui.notifications`.

## 5. Run it inside Yapin'

Close any running Yapin' instance, then launch it from the KDE application launcher. The managed runtime discovers the plugin on startup. Its `activate()` function should display a desktop notification:

- Title: **Hello from Y++**
- Message: **The plugin API and capability broker are connected.**

If it does not appear, launch from a terminal to capture the Y++ startup log:

```fish
set APPDIR "$HOME/.local/share/yplusplus/versions/yapper-desktop-1.2.7"
node "$HOME/.local/share/yplusplus/runtime/0.1.4/cli.js" launch "$APPDIR" --enable-logging
```

Look for `[Y++] Plugin started: dev.example.notification` or a specific trust, approval, or startup failure. Do not add `--no-sandbox`; Y++ intentionally refuses plugin execution when Chromium's global sandbox is disabled.

## 6. Verify capability revocation

Close Yapin' before changing the grant, then run:

```fish
npm run plugins -- revoke dev.example.notification 1.0.0 ui.notifications
npm run plugins -- list
```

Expected: the plugin remains trusted but moves to `WAITING_FOR_APPROVAL`. Relaunch Yapin': the plugin must not start and must not show its notification.

Restore the grant when finished:

```fish
npm run plugins -- approve dev.example.notification 1.0.0 ui.notifications
```

To remove execution trust as well:

```fish
npm run plugins -- untrust dev.example.notification 1.0.0
```

Trust revocation prevents startup on the next launch; it does not terminate an already-running renderer. Capability revocation is checked on each API call and blocks subsequent calls.

## Automated check

From the repository root:

```fish
npm test
npm run typecheck
npm run build
```

The notification example integration test verifies discovery, the separate trust and capability gates, READY state, and the actual entry source. The real Electron notification remains a manual smoke test.
