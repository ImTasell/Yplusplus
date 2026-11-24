# Y++ Plugin Architecture (RFC 0001)

Status: **Accepted foundation; implementation in progress**  
Target runtime line: **Y++ 0.x**  
Current bootstrap: **Y++ BOOT 0.1.0**

This document defines the first stable boundary between plugin authors and the Y++ host. It is deliberately narrower than the eventual framework: manifests, discovery, compatibility, and lifecycle contracts come first; executable plugin loading, workers, UI, and privileged adapters are separate milestones.

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

This is a broker/facade foundation, not yet a running plugin runtime: no plugin code is loaded, and no concrete Electron notification adapter or renderer-to-host RPC transport is wired up. The facade must remain host-controlled and must never be passed to untrusted plugin code until the isolated runtime boundary is implemented.

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

The eventual runtime should execute plugins outside the privileged Electron main process. A worker/RPC design is preferred, with structured-clone-compatible messages, request IDs, bounded payload sizes, timeouts, and explicit shutdown. The renderer preload remains a narrow bridge and must not expose `ipcRenderer`, Node globals, or arbitrary host callbacks.

The exact worker technology is intentionally deferred until the manifest and lifecycle contracts are implemented and measured in the target Electron version.

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

## Planned package boundaries

- `src/runtime/`: isolated plugin execution adapter and bounded RPC transport.
- A concrete Electron notification adapter and host UI integration.
- `src/runtime/`: isolated plugin execution adapter.
- Developer tooling, sample plugin, diagnostics, and UI.

These are conceptual boundaries, not a promise that every planned module exists today.

## Implementation order

1. Pure manifest schema and validation tests. (Implemented.)
2. Pure lifecycle transition model and exhaustive transition tests. (Implemented.)
3. Capability registry and approval/grant separation. (Policy foundation implemented; persistence/facades remain.)
4. Plugin discovery and validation, without executing third-party code. (Implemented.)
5. Plugin API compatibility policy. (Implemented.)
6. Plugin manager inspection/orchestration through READY. (Implemented; approval provider is injected.)
7. Persistent approval storage and host approval/revocation workflow. (Implemented; UI remains.)
8. Sandboxed execution adapter and narrow RPC (broker facade foundation implemented; transport remains).
9. Developer tooling, sample plugin, diagnostics, and UI.

The current Y++ BOOT patcher and preload remain independent of this plugin subsystem. Plugin work must not destabilize the verified Yapper 1.2.7 integration.
