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

The managed runtime is version `0.1.8`. Re-running the managed installer updates the runtime and rewrites the Yapin' desktop entry without replacing an already-managed AppDir with a different payload.

## Open the manager

In KDE, open the context menu for **Yapin' (Y++)** in the application launcher and choose **Plugin Manager**.

The desktop action starts the same managed Yapin' installation with `--yplusplus-plugin-manager`. The manager is a separate window with its own sandboxed renderer and narrow preload API.

Terminal fallback:

```fish
set APPDIR "$HOME/.local/share/yplusplus/versions/yapper-desktop-1.2.7"
node "$HOME/.local/share/yplusplus/runtime/0.1.8/cli.js" launch "$APPDIR" --yplusplus-plugin-manager
```

## Native Settings integration

The native **Settings → Plugins** page is kept outside Yapin's own settings-page
container. Opening it hides the native page container; choosing another native
settings entry restores the container before Yapin handles the click. The
injected content never uses Yapin's internal page class.

Each discovered plugin has an enable switch and a gear button:

- The switch persists enabled state by stable plugin ID, including across plugin updates.
- Switching off unloads the plugin runtime. Switching on starts it only when
  the release is already trusted and all requested capabilities are approved.
- Enabling does not trust a release or approve permissions. Those remain
  separate actions in Plugin Manager.
- The gear opens the plugin's host-rendered settings popup. Registered
  declarative settings panels are rendered there; plugin code does not supply
  HTML or JavaScript for the popup.

## Built-in Fonts plugin

The first-party **Fonts** plugin is bundled with the managed runtime and seeded
into the plugin directory on first launch. It has no requested capabilities.
Its gear popup provides a private TTF library:

- Import TrueType `.ttf` files up to 12 MiB each (64 fonts maximum).
- Select one imported font for Yapin's interface, or remove fonts.
- The **Apply selected font** setting can disable font application while
  keeping the plugin enabled.
- Font files and metadata are stored under
  `~/.local/share/yplusplus/fonts` with private directory/file permissions.
- Imported files are stored under generated names; the original path is not
  retained. The host validates TTF signatures and never exposes filesystem
  paths to the plugin.

The Fonts release is automatically trusted only when the host creates its
initial bundled copy and verifies that its manifest and entry match the
bundled files. Removing trust remains effective; later launches do not
silently re-trust an existing plugin directory.
## Permission workflow

1. Newly discovered plugins appear as **WAITING FOR TRUST**.
2. Choose **Trust release** to allow that exact plugin ID and version to execute. This grants no capabilities.
3. Approve each requested, supported capability individually.
4. A plugin becomes runnable only when it is trusted and every requested supported capability has been approved.
5. **Revoke** on a capability removes that grant. The running plugin's next API call is checked against the updated store and denied.
6. **Revoke trust** unloads that plugin's current runtime immediately and prevents it from starting again until trusted.
7. **Stop plugin** unloads a running plugin without changing trust or capability grants. **Start plugin** starts it again only while trust, enable state, and approvals remain valid.

Unsupported capabilities are displayed but cannot be approved by this host version.

## Security properties

- The manager window uses `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and disables DevTools.
- The preload exposes only fixed management operations; it never exposes `ipcRenderer`, Node APIs, store paths, or arbitrary IPC channels.
- Every IPC request checks the invoking webContents and its main frame URL.
- Navigation, popups, network requests, and permission requests are denied outside the manager's local asset directory.
- Trust and capability decisions continue to use the existing host-owned stores and `PluginApprovalController`.
- If Chromium was launched with `--no-sandbox`, the manager window is intentionally not opened.

## Native Settings and Fonts smoke test

- [ ] Open **Settings → Plugins** and confirm it appears between Advanced and Developer.
- [ ] Click Plugins → Advanced → Plugins repeatedly; no Plugins content should remain in or bleed into Advanced.
- [ ] Confirm each plugin has an enable switch and gear button.
- [ ] Turn a trusted plugin off; confirm its runtime unloads and the switch stays off after restarting Yapin'.
- [ ] Turn it back on; confirm it starts only when trust and required approvals are still valid.
- [ ] Open a plugin gear popup and edit one registered setting.
- [ ] Confirm the bundled **Fonts** plugin appears on first launch.
- [ ] Import a valid `.ttf`, select it, and confirm Yapin's interface changes font.
- [ ] Turn off **Apply selected font** and confirm the interface returns to its normal font.
- [ ] Disable Fonts and confirm the selected font is no longer applied.
- [ ] Try a non-TTF file and a file larger than 12 MiB; both should be rejected.
## Smoke test

- [ ] Open Plugin Manager from the Yapin' desktop entry's context menu.
- [ ] Confirm the notification example appears with its current trust and capability state.
- [ ] Revoke `ui.notifications`; confirm it changes to **Not approved**.
- [ ] Approve `ui.notifications` again; confirm it returns to **Approved**.
- [ ] Revoke trust; confirm the plugin is no longer running and returns to **WAITING FOR TRUST**.
- [ ] Trust it and approve the capability again; confirm it starts.
- [ ] Stop and start it from the manager without changing its trust or permissions.
