import assert from "node:assert/strict";
import test from "node:test";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createPluginCapabilityFacade } from "../../src/capabilities/broker.js";
import type { ManagedPlugin } from "../../src/plugins/manager.js";
import { createPluginApiClient } from "../../src/runtime/client.js";
import { bindRpcMessagePort, type RpcMessagePort } from "../../src/runtime/message-port.js";
import { PluginRpcSession } from "../../src/runtime/rpc-session.js";

function port(value: MessagePort): RpcMessagePort {
  return value as unknown as RpcMessagePort;
}

function readyPlugin(): ManagedPlugin {
  return {
    id: "dev.example.integration",
    name: "Integration fixture",
    version: "1.0.0",
    directory: "/plugins/integration",
    state: "READY",
    requestedPermissions: ["ui.notifications"],
    approvedPermissions: ["ui.notifications"],
    deniedPermissions: [],
    compatibility: { compatible: true, pluginApiVersion: 1, hostApiVersion: 1 },
  };
}

test("plugin API client calls through MessagePort, RPC session, and capability broker", async () => {
  const channel = new MessageChannel();
  const calls: Array<{ id: string; version: string; title: string; message: string }> = [];
  const facade = await createPluginCapabilityFacade(readyPlugin(), {
    getApprovedPermissions: async () => new Set(["ui.notifications"]),
    notifications: async (identity, request) => {
      calls.push({ ...identity, ...request });
    },
  });
  const session = new PluginRpcSession({ facade });
  const transport = bindRpcMessagePort(port(channel.port1), session);
  const api = createPluginApiClient(port(channel.port2));

  await api.notifications.show({ title: "  Plugin online  ", message: "  RPC works!  " });

  assert.deepEqual(calls, [{
    id: "dev.example.integration",
    version: "1.0.0",
    title: "Plugin online",
    message: "RPC works!",
  }]);

  api.close();
  transport.close();
});

test("revoking approval blocks subsequent plugin API calls without reconnecting", async () => {
  const channel = new MessageChannel();
  let approved = true;
  let calls = 0;
  const facade = await createPluginCapabilityFacade(readyPlugin(), {
    getApprovedPermissions: async () => approved
      ? new Set(["ui.notifications"])
      : new Set<string>(),
    notifications: async () => { calls += 1; },
  });
  const transport = bindRpcMessagePort(
    port(channel.port1),
    new PluginRpcSession({ facade }),
  );
  const api = createPluginApiClient(port(channel.port2));

  await api.notifications.show({ title: "Before", message: "Granted" });
  approved = false;
  await assert.rejects(api.notifications.show({
    title: "After",
    message: "Revoked",
  }), /host denied this capability/i);
  assert.equal(calls, 1);

  api.close();
  transport.close();
});
