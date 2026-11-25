import assert from "node:assert/strict";
import test from "node:test";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createPluginApiClient, PluginApiError } from "../../src/runtime/client.js";
import type { RpcMessagePort } from "../../src/runtime/message-port.js";

function port(value: MessagePort): RpcMessagePort {
  return value as unknown as RpcMessagePort;
}

test("sends notification requests and resolves successful responses", async () => {
  const channel = new MessageChannel();
  const host = port(channel.port1);
  const client = createPluginApiClient(port(channel.port2));
  const received = new Promise<unknown>((resolve) => {
    host.addEventListener("message", (event) => {
      resolve(event.data);
      const request = event.data as { requestId: string };
      host.postMessage({
        rpcVersion: 1, type: "response", requestId: request.requestId,
        ok: true, result: null,
      });
    });
    host.start();
  });
  const result = client.notifications.show({ title: "Hello", message: "From plugin" });
  const message = await received as {
    rpcVersion: number; type: string; method: string;
    payload: { title: string; message: string };
  };
  assert.equal(message.rpcVersion, 1);
  assert.equal(message.type, "request");
  assert.equal(message.method, "capabilities.notifications.show");
  assert.deepEqual(message.payload, { title: "Hello", message: "From plugin" });
  await result;
  client.close();
  host.close();
});

test("maps host errors to PluginApiError", async () => {
  const channel = new MessageChannel();
  const host = port(channel.port1);
  const client = createPluginApiClient(port(channel.port2));
  host.addEventListener("message", (event) => {
    const request = event.data as { requestId: string };
    host.postMessage({
      rpcVersion: 1, type: "response", requestId: request.requestId,
      ok: false, error: { code: "CAPABILITY_DENIED", message: "Denied." },
    });
  });
  host.start();
  await assert.rejects(
    client.notifications.show({ title: "No", message: "Permission" }),
    (error: unknown) => error instanceof PluginApiError &&
      error.code === "CAPABILITY_DENIED" && error.message === "Denied.",
  );
  client.close();
  host.close();
});

test("rejects pending calls when the client closes", async () => {
  const channel = new MessageChannel();
  const client = createPluginApiClient(port(channel.port2));
  const pending = client.notifications.show({ title: "Wait", message: "No host response" });
  client.close();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof PluginApiError && error.code === "SESSION_CLOSED");
  channel.port1.close();
});

test("enforces pending request limits and argument validation", async () => {
  const channel = new MessageChannel();
  const client = createPluginApiClient(port(channel.port2), { maxPendingRequests: 1 });
  const pending = client.notifications.show({ title: "One", message: "Pending" });
  await assert.rejects(
    client.notifications.show({ title: "Two", message: "Rejected" }),
    (error: unknown) => error instanceof PluginApiError && error.code === "RATE_LIMITED",
  );
  await assert.rejects(
    client.notifications.show({ title: 1, message: "Invalid" } as never),
    (error: unknown) => error instanceof PluginApiError && error.code === "INVALID_ARGUMENT",
  );
  client.close();
  await assert.rejects(pending);
  channel.port1.close();
});

test("times out unanswered calls and validates client limits", async () => {
  const channel = new MessageChannel();
  const client = createPluginApiClient(port(channel.port2), { requestTimeoutMs: 50 });
  await assert.rejects(
    client.notifications.show({ title: "Timeout", message: "No reply" }),
    (error: unknown) => error instanceof PluginApiError && error.code === "REQUEST_TIMEOUT",
  );
  client.close();
  channel.port1.close();
  const unused = new MessageChannel();
  assert.throws(() => createPluginApiClient(port(unused.port2), { maxPendingRequests: 0 }), RangeError);
  unused.port1.close();
  unused.port2.close();
});


test("client exposes settings get and set through RPC", async () => {
  const channel = new MessageChannel();
  const host = port(channel.port1);
  const client = createPluginApiClient(port(channel.port2));
  const seen: Array<{ method: string; payload: unknown }> = [];
  host.addEventListener("message", (event) => {
    const request = event.data as { requestId: string; method: string; payload: unknown };
    seen.push({ method: request.method, payload: request.payload });
    host.postMessage({
      rpcVersion: 1, type: "response", requestId: request.requestId,
      ok: true, result: request.method === "settings.get" ? "compact" : null,
    });
  });
  host.start();
  assert.equal(await client.settings.get("layout", "default"), "compact");
  await client.settings.set("layout", "compact");
  assert.deepEqual(seen, [
    { method: "settings.get", payload: { key: "layout", defaultValue: "default" } },
    { method: "settings.set", payload: { key: "layout", value: "compact" } },
  ]);
  client.close();
  host.close();
});


test("client receives host settings changes and unsubscribes on disposer", async () => {
  const channel = new MessageChannel();
  const host = port(channel.port1);
  const client = createPluginApiClient(port(channel.port2));
  let resolveSubscribed!: () => void;
  let resolveUnsubscribed!: () => void;
  const subscribed = new Promise<void>((resolve) => { resolveSubscribed = resolve; });
  const unsubscribed = new Promise<void>((resolve) => { resolveUnsubscribed = resolve; });
  host.addEventListener("message", (event) => {
    const request = event.data as { requestId: string; method: string; payload: { key: string } };
    if (request.method === "settings.subscribe") resolveSubscribed();
    if (request.method === "settings.unsubscribe") resolveUnsubscribed();
    host.postMessage({ rpcVersion: 1, type: "response", requestId: request.requestId, ok: true, result: null });
  });
  host.start();
  const values: unknown[] = [];
  const dispose = client.settings.onChange<number>("scale", (value) => values.push(value));
  await subscribed;
  host.postMessage({
    rpcVersion: 1, type: "event", event: "settings.change",
    payload: { key: "scale", value: 1.5 },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(values, [1.5]);
  dispose();
  await unsubscribed;
  client.close();
  host.close();
});


test("client registers declarative settings panels and returns an unregister disposer", async () => {
  const channel = new MessageChannel();
  const host = port(channel.port1);
  const client = createPluginApiClient(port(channel.port2));
  const seen: Array<{ method: string; payload: unknown }> = [];
  host.addEventListener("message", (event) => {
    const request = event.data as { requestId: string; method: string; payload: unknown };
    seen.push({ method: request.method, payload: request.payload });
    host.postMessage({ rpcVersion: 1, type: "response", requestId: request.requestId, ok: true, result: null });
  });
  host.start();
  const panel = { id: "general", title: "General", items: [{ type: "toggle" as const, id: "enabled", label: "Enabled", defaultValue: true }] };
  const dispose = client.ui.registerSettingsPanel(panel);
  await new Promise((resolve) => setTimeout(resolve, 0));
  dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, [
    { method: "ui.settingsPanel.register", payload: { panel } },
    { method: "ui.settingsPanel.unregister", payload: { panelId: "general" } },
  ]);
  client.close();
  host.close();
});
