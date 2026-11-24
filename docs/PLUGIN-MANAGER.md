# Y++ Plugin Manager

The first desktop Plugin Manager is a host-owned Electron window. It does not run inside the Yapin' website renderer and does not expose the trust store or permission store to plugins.

## Build and install

From the Y++ repository root:

```fish
npm test
npm run typecheck
npm run build
npm run install-managed -- "$HOME/Downloads/Executables/Yapper-Setup.AppImage"
```

The managed runtime is version `0.1.5`. Re-running the managed installer updates the runtime and rewrites the Yapin' desktop entry without replacing an already-managed AppDir with a different payload.

## Open the manager

In KDE, open the context menu for **Yapin' (Y++)** in the application launcher and choose **Plugin Manager**.

The desktop action starts the same managed Yapin' installation with `--yplusplus-plugin-manager`. The manager is a separate window with its own sandboxed renderer and narrow preload API.

Terminal fallback:

```fish
set APPDIR "$HOME/.local/share/yplusplus/versions/yapper-desktop-1.2.7"
node "$HOME/.local/share/yplusplus/runtime/0.1.5/cli.js" launch "$APPDIR" --yplusplus-plugin-manager
```

## Permission workflow

1. Newly discovered plugins appear as **WAITING FOR TRUST**.
2. Choose **Trust release** to allow that exact plugin ID and version to execute. This grants no capabilities.
3. Approve each requested, supported capability individually.
4. A plugin becomes runnable only when it is trusted and every requested supported capability has been approved.
5. **Revoke** on a capability removes that grant. The running plugin's next API call is checked against the updated store and denied.
6. **Revoke trust** unloads that plugin's current runtime immediately and prevents it from starting again until trusted.
7. **Stop plugin** unloads a running plugin without changing trust or capability grants. **Start plugin** starts it again only while trust and approvals remain valid.

Unsupported capabilities are displayed but cannot be approved by this host version.

## Security properties

- The manager window uses `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and disables DevTools.
- The preload exposes only fixed management operations; it never exposes `ipcRenderer`, Node APIs, store paths, or arbitrary IPC channels.
- Every IPC request checks the invoking webContents and its main frame URL.
- Navigation, popups, network requests, and permission requests are denied outside the manager's local asset directory.
- Trust and capability decisions continue to use the existing host-owned stores and `PluginApprovalController`.
- If Chromium was launched with `--no-sandbox`, the manager window is intentionally not opened.

## Smoke test

- [ ] Open Plugin Manager from the Yapin' desktop entry's context menu.
- [ ] Confirm the notification example appears with its current trust and capability state.
- [ ] Revoke `ui.notifications`; confirm it changes to **Not approved**.
- [ ] Approve `ui.notifications` again; confirm it returns to **Approved**.
- [ ] Revoke trust; confirm the plugin is no longer running and returns to **WAITING FOR TRUST**.
- [ ] Trust it and approve the capability again; confirm it starts.
- [ ] Stop and start it from the manager without changing its trust or permissions.
