# Y++ Plugin Architecture (RFC 0001)

Status: **Accepted foundation; implementation in progress**  
Target runtime line: **Y++ 0.x**  
Current bootstrap: **Y++ BOOT 0.1.0**

This document defines the first stable boundary between plugin authors and the Y++ host. It records the implemented manifest, discovery, approval, RPC, and sandboxed Electron execution foundations, while distinguishing those foundations from the remaining live Yapper integration, UI, and developer tooling.

## Design goals

- Plugins are identified and versioned independently of their display names.
- Every plugin declares the Y++ API generation it targets and the capabilities it requests.
- A declaration is not a grant. The host decides which capabilities are approved and supplies only the approved API surface.
- Lifecycle transitions are explicit, observable, and idempotent where practical.
- A plugin failure is isolated to that plugin and cannot prevent other plugins from starting.
- Untrusted plugin input is validated before it is used for filesystem access or execution.
- The first implementation must work with the existing TypeScript/Node toolchain and add no runtime dependencies.

## Non-goals for this milestone

- Running third-party code, evaluating plugin bundles, or loading arbitrary CommonJS.
- Giving plugins Electron, Node.js, filesystem, process, or raw IPC access.
- A settings UI, marketplace, hot reload, themes, patches, or DevTools.
- Treating a manifest permission request as user consent.

## Manifest format: `yplusplus.plugin.json`

Version 1 is UTF-8 JSON with this shape:

```json
{
  "manifestVersion": 1,
  "id": "dev.example.hello",
  "name": "Hello Y++",
  "version": "1.0.0",
  "description": "A small example plugin.",
  "apiVersion": 1,
  "entry": "dist/index.js",
  "permissions": ["ui.notifications"]
}
```

Required fields:

| Field | Contract |
| --- | --- |
| `manifestVersion` | Integer; currently exactly `1`. |
| `id` | Stable lowercase identifier, reverse-domain or slug form. Never derived from the display name. |
| `name` | Human-readable name, 1–80 characters. |
| `version` | SemVer version; prerelease/build metadata are allowed. |
| `description` | Human-readable summary, 1–240 characters. |
| `apiVersion` | Positive integer identifying the Y++ plugin API generation. |
| `entry` | Relative POSIX path to the future plugin entry point. No absolute paths, backslashes, empty segments, or traversal segments. |
| `permissions` | Array of unique, namespaced capability identifiers. An empty array is valid. |

Unknown fields are rejected in v1. This keeps typos from silently weakening or changing a plugin's intended configuration. Optional fields will be added only through a manifest-versioned contract.

The manifest parser validates data only. The filesystem discovery layer reads manifests and verifies that each declared entry exists as a regular file whose real path remains inside its plugin directory, including symlink resolution. Discovery does not install plugins, approve permissions, or execute entry points. Symlinked plugin directories and symlinked manifests are ignored/rejected.

## API compatibility

Manifest format and plugin API version are separate numbers. The current host implements plugin API generation **1**, exposed as `YPLUSPLUS_PLUGIN_API_VERSION` in `src/plugins/compatibility.ts`.

The compatibility policy currently requires an exact API-generation match. Both newer and older generations are rejected with a structured `unsupported-api-version` failure. The host does not assume that a newer API is backward-compatible with an older one; support for multiple generations must be an explicit future policy.

The plugin's own SemVer `version` identifies the plugin release. It is not compared with the Y++ BOOT package version, and the current manifest does not declare a minimum/maximum host package version.

## Capability model

A plugin may request capabilities such as `ui.notifications`, but the request is only metadata. The host's grant decision is a separate record tied to the plugin ID, installed version, and host policy. The runtime receives a capability object containing only approved operations.

Capabilities are narrow verbs, not broad namespaces such as `node`, `electron`, `filesystem`, or `ipc`. A future broker will own:
1. A versioned registry of supported capability identifiers.
2. User/host approval and revocation.
3. Per-plugin capability facades.
4. Runtime checks on every operation (not just at plugin startup).
5. Audit-friendly denial reasons without exposing secrets.

No capability is implemented or granted by this RFC. Unknown capability identifiers can be preserved by manifest validation so newer plugins remain inspectable; the broker denies capabilities absent from its registry.

### Capability broker foundation

`src/capabilities/broker.ts` now builds a least-privilege facade from a host-produced `ManagedPlugin` snapshot. The first implemented operation is `ui.notifications.show({ title, message })`. The broker only exposes it when the plugin is READY, API compatibility metadata is consistent, the manifest requested the capability, and the host approval store currently grants it.

Authorization is checked again on every call, so revoking a grant blocks subsequent calls without relying on a stale manager snapshot. Notification payloads are normalized and bounded (title 1–80 characters, message 1–500); extra keys, missing values, and accessor properties are rejected. The broker receives a trusted notification adapter from the host and does not import Electron or expose Node APIs.

The broker is connected to the RPC foundation and re-checks approval on every operation. `src/runtime/electron-host.ts` now wires the broker to Electron's native Notification API, MessageChannelMain, the sandboxed renderer adapter, and the runtime coordinator. The Yapper 1.2.7 BOOT patch now dynamically imports the managed `src/runtime/bootstrap.js` entry when `YPLUSPLUS_RUNTIME_ENTRY` is set. The bootstrap discovers plugins under the managed XDG data directory (or an absolute `YPLUSPLUS_PLUGIN_DIR` override), loads the persistent approval controller, starts only plugins already in READY, and unloads active runtimes before allowing Yapper to quit. Plugins waiting for approval remain stopped; there is not yet a user-facing approval UI.

### Persistent approval store

`src/capabilities/approval-store.ts` stores explicit capability grants under the user's XDG config directory (`$XDG_CONFIG_HOME/yplusplus/permissions.json`, falling back to `~/.config/yplusplus/permissions.json`). Each record is keyed by the exact plugin ID and SemVer release, so upgrading a plugin does not silently inherit the previous release's grants.

The store supports per-capability revocation, release-wide revocation, and plugin-wide revocation. Writes are serialized within the process, staged in the same directory, and atomically renamed. The containing directory is set to mode `0700`; the file is written as `0600`. Symlink/non-regular-file targets, broad file permissions, malformed JSON, unknown schema fields, duplicate records, and invalid values fail closed. This is host-side persistence only; it does not itself decide whether a capability exists or is safe to grant.

The host approval workflow is implemented by `src/plugins/approval-controller.ts`. The controller owns the store, feeds persistent grants into manager inspection, and exposes explicit host-side approve/revoke operations. Approval is restricted to capabilities that the exact plugin release requested and that the current capability registry supports. Incompatible plugins cannot be approved. These methods are host APIs and must never be exposed to plugin code. After an approval or revocation, call `inspect()` again to refresh the plugin's state. Example:

```ts
const approvals = new PluginApprovalController();
const report = await approvals.inspect(discovery);
await approvals.approve(discoveredPlugin, ["ui.notifications"]);
const refreshed = await approvals.inspect(discovery);
```

## Lifecycle contract

The lifecycle engine models these states:

```text
DISCOVERED -> VALIDATING -> WAITING_FOR_APPROVAL -> READY -> INITIALIZING -> ACTIVE
     |             |                 |                 |
     +----------> FAILED <-----------+-----------------+
                                                        |
ACTIVE <-> SUSPENDED                                    |
  |                                                     |
  +----------------------> UNLOADING -> UNLOADED <------+
```

Rules:

- Discovery never executes plugin code.
- Validation is complete before approval or initialization.
- Missing approval leaves a plugin waiting; it is not a failure.
- Initialization receives an immutable, least-privilege plugin context.
- Activation occurs only after initialization resolves successfully.
- Suspend/resume and unload are explicit lifecycle operations.
- Unload is terminal for an instance. Re-enable creates a fresh instance.
- A plugin's thrown error or rejected promise moves that plugin to `FAILED`; the host records the phase and error while redacting secrets.
- Repeated requests for the current state are no-ops. Invalid transitions return a structured error.

The current lifecycle module defines and tests transition rules only; it does not execute plugin code or perform side effects.

## Execution boundary

The runtime executes plugins in a dedicated sandboxed Electron renderer rather than a Node worker. The renderer is hidden and has no plugin UI in this first milestone. The preload exposes only the capability API and keeps raw IPC/MessagePort objects private. A restrictive CSP and per-plugin ephemeral session block network and other resource loading. The host still owns the MessagePort endpoint and binds one RPC session to it.

### RPC protocol foundation

`src/runtime/protocol.ts` defines protocol generation 1 and a strict request/response envelope. The initial allowlisted method is `capabilities.notifications.show`; arbitrary method names and extra envelope/payload fields are rejected. Incoming messages are copied into frozen plain data, with a 16 KiB encoded-size ceiling, bounded nesting/node count, strict request IDs, and accessor/symbol/non-JSON data rejection.

`src/runtime/rpc-session.ts` dispatches one authenticated plugin session's requests through a capability facade. It enforces a bounded in-flight count, a finite request timeout, duplicate-ID rejection, and a 4096-request session budget. Errors returned to plugins are generic and do not leak host adapter details. A timed-out operation retains its concurrency slot until the underlying operation actually settles; a timeout does not pretend to cancel a host side effect.

The transport adapter in `src/runtime/message-port.ts` now binds a `PluginRpcSession` to a standard MessagePort-like endpoint. It starts the port, dispatches each received message through that session, posts the bounded RPC response, and suppresses late replies after transport closure. The adapter accepts no plugin identity; the host must create the port pair and bind the session using trusted discovery/approval state before handing the other endpoint to a plugin runtime.

### Electron main-process MessagePort bridge

`src/runtime/electron-message-port.ts` adapts Electron's `MessagePortMain` EventEmitter API to the host's MessagePort interface. It retains the native endpoint so the execution adapter can transfer the plugin side through `webContents.postMessage`. The channel factory takes an injected `MessageChannelMain` constructor/factory, keeping Electron out of the core package's runtime dependencies.

### Sandboxed Electron execution adapter

`src/runtime/electron-execution.ts` now provides `createElectronPluginExecutionAdapter()`. It creates one hidden BrowserWindow per plugin with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, a unique non-persistent session partition, no DevTools, and no webview support. Navigation and popups are denied; session permission checks are denied; the session's request hook allows only the trusted bootstrap HTML and blocks other URL requests. The adapter re-reads and validates the manifest and entry immediately before execution, checks real-path containment, and bounds the entry source to 2 MiB by default.

The dedicated preload at `src/runtime/assets/plugin-preload.cjs` receives the transferred MessagePort and exposes only `window.yplusplus.notifications.show()`. It does not expose `ipcRenderer`, Node globals, or the raw port. The trusted bootstrap document at `src/runtime/assets/plugin-host.html` applies a restrictive CSP (`default-src 'none'`, no connections, frames, media, workers, or remote scripts; Blob modules are allowed for the validated entry). The adapter waits for a preload-only nonce handshake, then imports the self-contained ESM entry in the page's main world and awaits its exported `activate()` function. Relative imports from a Blob URL are not supported in this first entry contract; plugins should ship a bundled, self-contained ESM entry.

`npm run build` copies these two runtime assets into `dist/src/runtime/assets/`; `resolveElectronPluginRuntimeAssets()` returns their paths beside the compiled adapter. Electron remains an injected dependency, so the Y++ core does not add Electron as an npm runtime dependency. The caller supplies BrowserWindow, ipcMain, MessageChannelMain, Notification, and an `isSandboxDisabled()` guard. `isElectronSandboxDisabled(app)` checks both `app.commandLine.hasSwitch('no-sandbox')` and `process.argv`; use it rather than hardcoding `false`.

**Important sandbox caveat:** if the parent Yapper process was launched with `--no-sandbox`, Chromium's global sandbox is disabled. In that state the adapter refuses to start third-party plugins even though the window requests `sandbox: true`. The host must not lie in `isSandboxDisabled()`. This is particularly relevant to the existing BOOT launcher fallback, which may add `--no-sandbox` when user namespaces are unavailable. The adapter is execution plumbing, not a promise that every host launch can safely run plugins.

`src/runtime/electron-host.ts` provides `createElectronPluginRuntimeHost()`, which connects the sandbox adapter, MessageChannelMain, persistent approval provider, RPC broker, and native Electron Notification constructor. `src/runtime/bootstrap.ts` now invokes this factory from the patched Yapper main process, performs plugin discovery/inspection, starts READY plugins, and handles orderly shutdown. `PluginRuntimeHost` permits asynchronous session creation and bounds that setup with its startup timeout. This is source-level integration; a real Electron/Yapper runtime test is still required.

### Plugin-side API client and end-to-end RPC

`src/runtime/client.ts` provides the plugin-facing `createPluginApiClient(port)` API for tests and non-Electron adapters. The production preload currently implements the same narrow `notifications.show({ title, message })` contract directly so it can remain a small sandbox-compatible CommonJS file. Both paths use bounded pending calls and timeouts; the host validates every request and rechecks persistent approval through the capability broker.

`test/runtime/integration.test.ts` exercises the complete in-process path: plugin API client → MessagePort → host RPC session → capability broker → trusted notification adapter. It also verifies that revoking approval blocks subsequent calls without reconnecting. This proves the RPC/capability path, not the Electron sandbox or a real desktop notification.

A minimal example manifest and self-contained ESM entry live in `examples/notification-plugin/`. The entry expects the preload to install the frozen `globalThis.yplusplus` API before the adapter calls its exported `activate()` function. The adapter can execute this entry when supplied a READY plugin snapshot and a host-created Electron MessagePort channel. `createElectronPluginRuntimeHost()` now supplies that channel, broker session, and native notification adapter; automatic installation, user-facing approval UI, and live Yapper host wiring remain separate work.

### Runtime host coordinator

`src/runtime/host.ts` coordinates one runtime instance per plugin ID. It accepts only compatible plugins in READY, creates a channel and capability-backed RPC session through host-injected factories, transfers the plugin endpoint to an injected execution adapter, and marks the plugin ACTIVE only after adapter startup resolves. Startup is bounded by a configurable timeout; failures and unexpected exits move the runtime to FAILED, close both channel endpoints, and terminate the execution handle. Explicit unload revokes the channel and terminates the isolated renderer before reaching UNLOADED. A failed instance may be unloaded and then started again as a fresh instance.

The execution adapter is deliberately injected: the coordinator does not silently choose Node `worker_threads` as a sandbox. Node workers have access to Node APIs and are **not** a security boundary for hostile third-party code. `createElectronPluginExecutionAdapter()` is the current sandboxed Electron implementation; the coordinator still owns lifecycle and fault containment, while the Electron adapter owns renderer isolation, entry loading, and startup handshake.

The transport and client now form a tested end-to-end RPC/capability path. They still do not create an Electron renderer, choose an isolation policy, authenticate an arbitrary caller outside host-owned construction, or execute plugin code. The host must keep the host-side port private, bind exactly one session to each plugin endpoint, and never accept an identity supplied in the RPC payload.

## Implemented package boundaries

- `src/plugins/manifest.ts`: manifest types and pure validation.
- `src/plugins/lifecycle.ts`: lifecycle states and transition policy.
- `src/plugins/discovery.ts`: immediate-child directory discovery, manifest validation, duplicate-ID rejection, and entry-point containment checks.
- `src/plugins/compatibility.ts`: exact plugin API-generation compatibility policy.
- `src/plugins/manager.ts`: discovery/compatibility/approval orchestration and lifecycle snapshot; stops at READY and never executes entries.
- `src/plugins/approval-controller.ts`: host-owned explicit approval/revocation workflow connected to persistent storage and manager inspection.
- `src/capabilities/registry.ts`: capability catalog and pure grant-decision policy.
- `src/capabilities/broker.ts`: least-privilege notification facade with per-call approval checks and bounded payload validation.
- `src/capabilities/approval-store.ts`: persistent, version-scoped approval decisions with fail-closed validation and revocation.
- `src/runtime/protocol.ts`: strict, bounded, versioned RPC envelopes and payload parsing.
- `src/runtime/rpc-session.ts`: host dispatcher with concurrency limits, timeouts, and duplicate-request protection.
- `src/runtime/message-port.ts`: MessagePort transport adapter for one host-bound RPC session.
- `src/runtime/host.ts`: host-side runtime coordinator for startup, activation, crash handling, and unload.
- `src/runtime/client.ts`: plugin-side narrow capability API client.
- `src/runtime/electron-message-port.ts`: adapter for Electron MessagePortMain and native-port transfer.
- `src/runtime/electron-execution.ts`: hidden sandboxed BrowserWindow execution adapter with entry revalidation and startup handshake.
- `src/runtime/electron-host.ts`: concrete Electron channel, capability broker, notification, and runtime-host wiring.
- `src/runtime/assets/plugin-preload.cjs` and `plugin-host.html`: minimal isolated preload and restrictive bootstrap document.

## Planned package boundaries

- User-facing plugin approval and management UI, plus real Electron/Yapper integration tests.
- Plugin installation, user-facing approval/management UI, developer tooling, diagnostics, and real Electron integration tests.

These are conceptual boundaries, not a promise that every planned module exists today.

## Implementation order

1. Pure manifest schema and validation tests. (Implemented.)
2. Pure lifecycle transition model and exhaustive transition tests. (Implemented.)
3. Capability registry and approval/grant separation. (Registry, persistence, broker facade, revocation, and native notification adapter implemented; user-facing approval UI remains.)
4. Plugin discovery and validation, without executing third-party code. (Implemented.)
5. Plugin API compatibility policy. (Implemented.)
6. Plugin manager inspection/orchestration through READY. (Implemented; approval provider is injected.)
7. Persistent approval storage and host approval/revocation workflow. (Implemented; UI remains.)
8. Sandboxed execution adapter and narrow RPC (protocol, session dispatcher, plugin client, MessagePort transport, Electron MessagePortMain adapter, runtime coordinator, sandboxed BrowserWindow adapter, native notification host factory, and BOOT main-process bootstrap implemented; real Electron/Yapper validation remains).
9. Developer tooling, diagnostics, and UI. (The example entry can be executed by the Electron host factory; automatic plugin installation, user-facing approval, and management UI remain.)

The Y++ BOOT patcher now has a version-specific main-process hook for the managed plugin runtime, while the renderer preload remains a separate bridge. Keep the plugin bootstrap fail-closed and validate against the actual Yapper 1.2.7 AppImage before treating live integration as verified.
