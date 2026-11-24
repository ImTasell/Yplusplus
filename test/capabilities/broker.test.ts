import assert from "node:assert/strict";
import test from "node:test";
import type { ManagedPlugin } from "../../src/plugins/manager.js";
import {
  CapabilityDeniedError,
  createPluginCapabilityFacade,
  type NotificationRequest,
} from "../../src/capabilities/broker.js";

function managedPlugin(overrides: Partial<ManagedPlugin> = {}): ManagedPlugin {
  return {
    id: "dev.example.broker",
    name: "Broker fixture",
    version: "1.0.0",
    directory: "/plugins/broker",
    state: "READY",\n    trusted: true,
    requestedPermissions: ["ui.notifications"],
    approvedPermissions: ["ui.notifications"],
    deniedPermissions: [],
    compatibility: { compatible: true, pluginApiVersion: 1, hostApiVersion: 1 },
    ...overrides,
  };
}

test("exposes only the approved notification facade", async () => {
  const calls: { plugin: { id: string; version: string }; request: NotificationRequest }[] = [];
  const facade = await createPluginCapabilityFacade(managedPlugin(), {
    getApprovedPermissions: async () => new Set(["ui.notifications"]),
    notifications: (plugin, request) => { calls.push({ plugin, request }); },
  });
  assert.ok(facade.notifications);
  await facade.notifications.show({ title: " Hello ", message: " World " });
  assert.deepEqual(calls, [{
    plugin: { id: "dev.example.broker", version: "1.0.0" },
    request: { title: "Hello", message: "World" },
  }]);
  assert.equal(Object.isFrozen(facade), true);
  assert.equal(Object.isFrozen(facade.notifications), true);
});

test("rejects a READY snapshot without explicit trust", async () => {\n  await assert.rejects(createPluginCapabilityFacade(managedPlugin({ trusted: false }), {\n    getApprovedPermissions: async () => new Set(["ui.notifications"]),\n    notifications: () => undefined,\n  }), CapabilityDeniedError);\n});\n\ntest("does not expose capabilities that were not approved", async () => {
  const facade = await createPluginCapabilityFacade(managedPlugin(), {
    getApprovedPermissions: async () => new Set(),
    notifications: () => assert.fail("adapter must not be called"),
  });
  assert.deepEqual(facade, {});
});

test("does not expose capabilities that the plugin did not request", async () => {
  const facade = await createPluginCapabilityFacade(managedPlugin({
    requestedPermissions: [],
    approvedPermissions: [],
  }), {
    getApprovedPermissions: async () => new Set(["ui.notifications"]),
    notifications: () => assert.fail("adapter must not be called"),
  });
  assert.deepEqual(facade, {});
});

test("rejects facade creation for plugins not in READY state", async () => {
  await assert.rejects(createPluginCapabilityFacade(managedPlugin({
    state: "WAITING_FOR_APPROVAL",
  }), {
    getApprovedPermissions: async () => new Set(["ui.notifications"]),
    notifications: () => undefined,
  }), CapabilityDeniedError);
});

test("revocation is checked again on every operation", async () => {
  let approved = true;
  let calls = 0;
  const facade = await createPluginCapabilityFacade(managedPlugin(), {
    getApprovedPermissions: async () => new Set(approved ? ["ui.notifications"] : []),
    notifications: () => { calls += 1; },
  });
  assert.ok(facade.notifications);
  await facade.notifications.show({ title: "Allowed", message: "First call" });
  approved = false;
  await assert.rejects(
    facade.notifications.show({ title: "Denied", message: "After revoke" }),
    CapabilityDeniedError,
  );
  assert.equal(calls, 1);
});

test("validates notification payload fields and bounds", async () => {
  const facade = await createPluginCapabilityFacade(managedPlugin(), {
    getApprovedPermissions: async () => new Set(["ui.notifications"]),
    notifications: () => undefined,
  });
  const show = facade.notifications!.show;
  await assert.rejects(show({ title: "", message: "Body" }), RangeError);
  await assert.rejects(show({ title: "Title", message: " " }), RangeError);
  await assert.rejects(show({ title: "x".repeat(81), message: "Body" }), RangeError);
  await assert.rejects(show({ title: "Title", message: "x".repeat(501) }), RangeError);
  await assert.rejects(show({ title: "Title" } as NotificationRequest), TypeError);
  await assert.rejects(show({ title: "Title", message: "Body", extra: true } as NotificationRequest), TypeError);
});

test("rejects accessor properties without invoking plugin-controlled getters", async () => {
  const facade = await createPluginCapabilityFacade(managedPlugin(), {
    getApprovedPermissions: async () => new Set(["ui.notifications"]),
    notifications: () => undefined,
  });
  let getterCalls = 0;
  const payload = Object.defineProperty({}, "title", {
    enumerable: true,
    get() { getterCalls += 1; return "Injected"; },
  });
  Object.defineProperty(payload, "message", { enumerable: true, value: "Body" });
  await assert.rejects(facade.notifications!.show(payload as NotificationRequest), TypeError);
  assert.equal(getterCalls, 0);
});

test("rejects inconsistent API compatibility metadata", async () => {
  await assert.rejects(createPluginCapabilityFacade(managedPlugin({
    compatibility: { compatible: true, pluginApiVersion: 0, hostApiVersion: 1 },
  }), {
    getApprovedPermissions: async () => new Set(["ui.notifications"]),
    notifications: () => undefined,
  }), CapabilityDeniedError);
});
