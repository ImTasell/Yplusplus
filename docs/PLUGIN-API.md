# Y++ Plugin API

**Status:** API-1 contract draft  
**API generation:** 1  
**Manifest:** `yplusplus.plugin.json`  
**Entry format:** self-contained ESM bundle

This document defines Y++'s independent plugin API. It is not a Yapmod
compatibility layer. Yapmod is an architectural reference only.

## Goals

- Keep Electron, Node.js, filesystem access, and raw IPC out of plugin code.
- Expose narrow host-mediated operations through the capability broker.
- Keep plugin execution isolated from Yapin's remote renderer.
- Make UI contributions declarative so trusted host UI renders them.
- Separate execution trust from individual capability grants.
- Keep the public API transport-neutral.

## Plugin entry point

A plugin ships a self-contained ESM entry module. The host loads it only after
manifest validation, exact-release execution trust, compatibility checks, and
approval of every requested capability.

The canonical TypeScript contract is `YPlusPlusAPI` in
`src/plugins/api.ts`. The plugin SDK/package distribution is a separate
packaging task; this repository path is the source of truth for API-1 types.

```ts
export async function activate(api: YPlusPlusAPI) {
  api.logger.info("Plugin activated");

  await api.notifications.show({
    title: "Hello from Y++",
    message: "The plugin API is connected.",
  });

  api.onCleanup(() => {
    api.logger.info("Plugin unloaded");
  });
}
```

The host may also accept a cleanup function returned by `activate`. Cleanup
must be idempotent and is run during unload. Plugins must not assume that
cleanup runs after a process crash or forced termination.

## API surface

| Namespace | Contract |
|---|---|
| `api.plugin` | Immutable plugin identity and API generation |
| `api.logger` | Structured debug/info/warn/error logging |
| `api.notifications` | Native notification requests, subject to `ui.notifications` |
| `api.settings` | Persistent, plugin-scoped values and change subscriptions |
| `api.ui` | Declarative settings-panel registration |
| `api.events` | Typed application lifecycle event subscriptions |
| `api.onCleanup` | Register instance cleanup callbacks |

The API object and all nested namespace objects are host-created, frozen
facades. A plugin cannot use these interfaces to obtain a Node, Electron,
filesystem, IPC, or Yapin-window reference.

## Settings

Settings are scoped to the plugin ID and installed release policy. Keys are
plugin-local. Supported values in API-1 are strings, finite numbers, and
booleans. The host validates keys, value size, and type before persistence.
A plugin must provide a default to `get`; defaults are not silently written
until the plugin or host explicitly stores a value.

`onChange` returns an unsubscribe function. Unsubscribing and unloading the
plugin must remove the listener.

## Settings panels

Plugins register settings panels with declarative data only:

- `toggle`: boolean
- `text`: bounded string
- `number`: finite number with optional bounds and step
- `select`: one value from a finite option list

Panel IDs and item IDs are stable, plugin-local identifiers. The host rejects
duplicate IDs, unsupported icons, invalid defaults, excessive item counts,
and malformed definitions.

The trusted Y++ integration renders these definitions inside Yapin's native
Settings experience. Plugin code does not receive DOM access to the settings
page and cannot supply arbitrary HTML, CSS, or renderer-side callbacks.
Control changes are persisted by the host and delivered through the settings
subscription API.

A panel registration returns a disposer. The host removes all panels belonging
to a plugin automatically when that plugin is unloaded.

## Events

API-1 event subscriptions are named, typed, and host-defined. Unknown event
names are rejected. Event payloads are copied into bounded plain data before
delivery. Subscriptions are removed on explicit unsubscribe and plugin unload.

The initial lifecycle event set is:

- `application.ready`
- `application.will-quit`

The host must not expose arbitrary window, document, network, or internal
application objects as event payloads.

## Permissions and enforcement

Manifest `permissions` entries are requests, not grants. Execution trust and
capability approval are separate host-side decisions scoped to the exact
plugin ID and version.

The first capability is:

- `ui.notifications`: permits `api.notifications.show`.

No API namespace implicitly grants additional permissions. Unknown capability
names remain denied. The broker re-checks current approval for every privileged
operation so revocation takes effect without trusting a stale plugin-side view.

Settings, panel registration, logging, and event delivery are host-mediated
services; they do not grant access to arbitrary host resources.

## Lifecycle

1. Discover and validate the manifest without executing plugin code.
2. Check exact API-generation compatibility.
3. Require explicit trust for the exact plugin release.
4. Obtain approvals for requested capabilities.
5. Create an isolated plugin runtime and narrow API facade.
6. Await `activate(api)`; only then mark the instance active.
7. On unload, revoke its RPC session, dispose registrations and subscriptions,
   run cleanup callbacks in reverse registration order, and terminate its
   isolated execution context.

An activation failure moves the instance to failed state and triggers cleanup
of resources already registered.

## Versioning

`manifestVersion` versions the JSON manifest schema.
`apiVersion` versions this public plugin contract.
The RPC protocol version is independently versioned.

API generations are exact-match by default. Supporting an older generation
requires an explicit compatibility adapter and tests; a newer host must not
assume backward compatibility automatically.

## Implementation status

This document describes the API-1 target contract; not every namespace is
implemented yet. Notifications and plugin-scoped persistent settings are wired
through the host-owned RPC facade. `settings.get`, `settings.set`, and
`settings.onChange` use `src/plugins/plugin-settings-store.ts`; subscriptions
are disposed when the RPC session closes.

Settings-panel definitions are validated by the host-owned registry and
registered/unregistered over plugin RPC. The native Yapin Settings integration
adds a Plugins navigation entry and renders the host-validated toggle, text,
number, and select controls inside the existing Settings modal. Its IPC surface
is read/write-only and validates the requesting main frame, registered panel,
item identity, and value type/range. It does not expose plugin trust, approval,
or lifecycle actions to the remote renderer. Settings values are persisted by
the host, and panel registrations disappear when their plugin session closes.

Logging and application lifecycle events remain follow-on implementation
batches. The public `src/plugins/api.ts` contract remains the source of truth
for the full API-1 target surface.
