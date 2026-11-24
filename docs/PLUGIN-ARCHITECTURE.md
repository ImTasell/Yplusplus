# Y++ Plugin Architecture (RFC 0001)

Status: **Accepted foundation; implementation in progress**  
Target runtime line: **Y++ 0.x**  
Current bootstrap: **Y++ BOOT 0.1.0**

This document defines the first stable boundary between plugin authors and the Y++ host. It is deliberately narrower than the eventual framework: manifests and lifecycle contracts come first; executable plugin loading, workers, UI, and privileged adapters are separate milestones.

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

The manifest parser validates data only. It does not read files, resolve paths, install plugins, approve permissions, or execute the entry point. A future installer must resolve the entry against the plugin root and verify the resulting real path remains inside that root (including symlink handling).

## Capability model

A plugin may request capabilities such as `ui.notifications`, but the request is only metadata. The host's grant decision is a separate record tied to the plugin ID, installed version, and host policy. The runtime receives a capability object containing only approved operations.

Capabilities are narrow verbs, not broad namespaces such as `node`, `electron`, `filesystem`, or `ipc`. A future broker will own:
1. A versioned registry of supported capability identifiers.
2. User/host approval and revocation.
3. Per-plugin capability facades.
4. Runtime checks on every operation (not just at plugin startup).
5. Audit-friendly denial reasons without exposing secrets.

No capability is implemented or granted by this RFC. Unknown capability identifiers can be preserved by manifest validation so newer plugins remain inspectable; the broker must deny capabilities absent from its registry.

## Lifecycle contract

The lifecycle engine will model these states:

```text
DISCOVERED -> VALIDATING -> WAITING_FOR_APPROVAL -> INITIALIZING -> ACTIVE
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

The initial implementation will define and test transition rules before connecting them to executable modules.

## Execution boundary

The eventual runtime should execute plugins outside the privileged Electron main process. A worker/RPC design is preferred, with structured-clone-compatible messages, request IDs, bounded payload sizes, timeouts, and explicit shutdown. The renderer preload remains a narrow bridge and must not expose `ipcRenderer`, Node globals, or arbitrary host callbacks.

The exact worker technology is intentionally deferred until the manifest and lifecycle contracts are implemented and measured in the target Electron version.

## Planned package boundaries

- `src/plugins/manifest.ts`: manifest types and pure validation.
- `src/plugins/lifecycle.ts`: lifecycle states and transition policy.
- `src/plugins/manager.ts`: discovery and orchestration; later milestone.
- `src/capabilities/`: capability registry, approval records, and scoped facades; later milestone.
- `src/runtime/`: plugin execution adapter; later milestone.

These are conceptual boundaries, not a promise that every directory exists today.

## Compatibility policy

- Manifest format and plugin API version are separate numbers.
- A plugin declares both `manifestVersion` and `apiVersion`.
- Unsupported manifest versions are rejected.
- Unsupported API generations are reported as compatibility failures before initialization.
- A future API may add capabilities without changing the manifest format; changing required manifest fields requires a new manifest version.

## Implementation order

1. Pure manifest schema and validation tests.
2. Pure lifecycle transition model and exhaustive transition tests.
3. Capability registry and approval/grant separation.
4. Plugin discovery and manager, still without executing third-party code.
5. Sandboxed execution adapter and narrow RPC.
6. Developer tooling, sample plugin, diagnostics, and UI.

The current Y++ BOOT patcher and preload remain independent of this plugin subsystem. Plugin work must not destabilize the verified Yapper 1.2.7 integration.
