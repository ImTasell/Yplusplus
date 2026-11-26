import assert from "node:assert/strict";
import test from "node:test";
import { PluginRpcSession } from "../../src/runtime/rpc-session.js";
import {
  parseRpcRequest,
  RpcProtocolError,
  YPLUSPLUS_RPC_VERSION,
} from "../../src/runtime/protocol.js";
import type { PluginCapabilityFacade } from "../../src/capabilities/broker.js";

const request = (requestId = "req_1", payload: unknown = { title: "Title", message: "Body" }) => ({
  rpcVersion: YPLUSPLUS_RPC_VERSION,
  type: "request",
  requestId,
  method: "capabilities.notifications.show",
  payload,
});
function facade(show?: (payload: { title: string; message: string }) => Promise<void>): PluginCapabilityFacade {
  return show ? { notifications: { show } } : {};
}

test("parses and freezes a valid request", () => {
  const parsed = parseRpcRequest(request());
  assert.equal(parsed.requestId, "req_1");
  assert.equal(parsed.payload.title, "Title");
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.payload), true);
});

test("rejects unknown envelope fields and methods", () => {
  assert.throws(() => parseRpcRequest({ ...request(), admin: true }), RpcProtocolError);
  assert.throws(() => parseRpcRequest({ ...request(), method: "node.exec" }), /not supported/);
});

test("rejects unsupported protocol versions and malformed IDs", () => {
  assert.throws(() => parseRpcRequest({ ...request(), rpcVersion: 2 }), /Unsupported/);
  assert.throws(() => parseRpcRequest({ ...request(), requestId: "bad id" }), /request ID/);
});

test("rejects malformed notification payloads", () => {
  assert.throws(() => parseRpcRequest(request("x", { title: "Only title" })), /only string title/);
  assert.throws(() => parseRpcRequest(request("x", { title: "T", message: "M", extra: true })), /only string/);
});

test("rejects accessor properties without invoking getters", () => {
  let calls = 0;
  const payload = Object.defineProperty({ message: "Body" }, "title", {
    enumerable: true,
    get() { calls += 1; return "Title"; },
  });
  assert.throws(() => parseRpcRequest(request("x", payload)), RpcProtocolError);
  assert.equal(calls, 0);
});

test("rejects oversized and deeply nested payloads", () => {
  assert.throws(() => parseRpcRequest(request("x", { title: "x".repeat(17_000), message: "Body" })), /limit/);
  let nested: unknown = "end";
  for (let i = 0; i < 12; i += 1) nested = { nested };
  assert.throws(() => parseRpcRequest(request("x", nested)), /structural limits/);
});

test("dispatches an approved notification through the facade", async () => {
  const calls: unknown[] = [];
  const session = new PluginRpcSession({ facade: facade(async (payload) => { calls.push(payload); }) });
  const result = await session.dispatch(request());
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ title: "Title", message: "Body" }]);
  assert.equal(session.inFlightRequests, 0);
});

test("denies a capability absent from the facade", async () => {
  const session = new PluginRpcSession({ facade: facade() });
  const result = await session.dispatch(request());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "CAPABILITY_DENIED");
});

test("rejects duplicate request IDs", async () => {
  const session = new PluginRpcSession({ facade: facade(async () => undefined) });
  assert.equal((await session.dispatch(request("same"))).ok, true);
  const duplicate = await session.dispatch(request("same"));
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, "INVALID_MESSAGE");
});

test("enforces concurrent request limits", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const session = new PluginRpcSession({
    facade: facade(async () => blocked),
    maxConcurrentRequests: 1,
  });
  const first = session.dispatch(request("first"));
  await Promise.resolve();
  const second = await session.dispatch(request("second"));
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.code, "RATE_LIMITED");
  release();
  assert.equal((await first).ok, true);
});

test("maps broker revocation denials to a generic RPC denial", async () => {
  const error = Object.assign(new Error("private internal detail"), { name: "CapabilityDeniedError" });
  const session = new PluginRpcSession({ facade: facade(async () => { throw error; }) });
  const result = await session.dispatch(request());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "CAPABILITY_DENIED");
    assert.doesNotMatch(result.error.message, /private/);
  }
});

test("times out capability operations but retains the slot until the operation settles", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const session = new PluginRpcSession({
    facade: facade(() => blocked),
    maxConcurrentRequests: 1,
    requestTimeoutMs: 50,
  });
  const result = await session.dispatch(request("timeout"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "REQUEST_TIMEOUT");
  assert.equal(session.inFlightRequests, 1);

  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.inFlightRequests, 0);
});

test("validates session limits", () => {
  assert.throws(() => new PluginRpcSession({ facade: facade(), maxConcurrentRequests: 0 }), RangeError);
  assert.throws(() => new PluginRpcSession({ facade: facade(), requestTimeoutMs: 1 }), RangeError);
});

test("timed-out operations retain concurrency slots until they actually settle", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const session = new PluginRpcSession({
    facade: facade(() => blocked),
    maxConcurrentRequests: 1,
    requestTimeoutMs: 50,
  });
  const first = await session.dispatch(request("slow"));
  assert.equal(first.ok, false);
  assert.equal(session.inFlightRequests, 1);
  const second = await session.dispatch(request("blocked"));
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.code, "RATE_LIMITED");
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.inFlightRequests, 0);
});


test("parses settings get and set requests with primitive values", () => {
  const get = parseRpcRequest({
    rpcVersion: YPLUSPLUS_RPC_VERSION, type: "request", requestId: "get_1",
    method: "settings.get", payload: { key: "theme", defaultValue: "dark" },
  });
  assert.equal(get.method, "settings.get");
  assert.equal(get.payload.key, "theme");
  const set = parseRpcRequest({
    rpcVersion: YPLUSPLUS_RPC_VERSION, type: "request", requestId: "set_1",
    method: "settings.set", payload: { key: "scale", value: 1.25 },
  });
  assert.equal(set.method, "settings.set");
  assert.equal(set.payload.value, 1.25);
  assert.throws(() => parseRpcRequest({
    rpcVersion: YPLUSPLUS_RPC_VERSION, type: "request", requestId: "bad_1",
    method: "settings.set", payload: { key: "x", value: Number.NaN },
  }), /non-JSON|primitive/);
});

test("dispatches settings get and set through the plugin-bound facade", async () => {
  const values = new Map<string, string | number | boolean>();
  const session = new PluginRpcSession({ facade: {
    settings: {
      async get(key, fallback) { return values.has(key) ? values.get(key)! : fallback; },
      async set(key, value) { values.set(key, value); },
      subscribe() { return () => undefined; },
    },
  } });
  const get = await session.dispatch({
    rpcVersion: YPLUSPLUS_RPC_VERSION, type: "request", requestId: "settings_get",
    method: "settings.get", payload: { key: "mode", defaultValue: "default" },
  });
  assert.equal(get.ok, true);
  if (get.ok) assert.equal(get.result, "default");
  const set = await session.dispatch({
    rpcVersion: YPLUSPLUS_RPC_VERSION, type: "request", requestId: "settings_set",
    method: "settings.set", payload: { key: "mode", value: "compact" },
  });
  assert.equal(set.ok, true);
  assert.equal(values.get("mode"), "compact");
  const updated = await session.dispatch({
    rpcVersion: YPLUSPLUS_RPC_VERSION, type: "request", requestId: "settings_get2",
    method: "settings.get", payload: { key: "mode", defaultValue: "default" },
  });
  assert.equal(updated.ok, true);
  if (updated.ok) assert.equal(updated.result, "compact");
});

test("denies settings RPC when no host settings facade is bound", async () => {
  const session = new PluginRpcSession({ facade: {} });
  const result = await session.dispatch({
    rpcVersion: YPLUSPLUS_RPC_VERSION, type: "request", requestId: "settings_denied",
    method: "settings.get", payload: { key: "x", defaultValue: false },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "CAPABILITY_DENIED");
});


test("settings subscriptions emit host changes and dispose on session close", async () => {
  const listeners = new Map<string, (value: string | number | boolean) => void>();
  let disposed = 0;
  const session = new PluginRpcSession({ facade: { settings: {
    async get(_key, fallback) { return fallback; },
    async set() {},
    subscribe(key, listener) { listeners.set(key, listener); return () => { listeners.delete(key); disposed += 1; }; },
  } } });
  const events: unknown[] = [];
  session.setEventSink((event) => events.push(event));
  const result = await session.dispatch({
    rpcVersion: YPLUSPLUS_RPC_VERSION, type: "request", requestId: "subscribe_1",
    method: "settings.subscribe", payload: { key: "density" },
  });
  assert.equal(result.ok, true);
  listeners.get("density")?.(42);
  assert.deepEqual(events, [{
    rpcVersion: YPLUSPLUS_RPC_VERSION, type: "event", event: "settings.change",
    payload: { key: "density", value: 42 },
  }]);
  session.close();
  assert.equal(disposed, 1);
  assert.equal(listeners.size, 0);
});


test("parses declarative settings panel registration and removal RPC", () => {
  const panel = { id: "general", title: "General", items: [{ type: "toggle", id: "enabled", label: "Enabled", defaultValue: true }] };
  const parsed = parseRpcRequest({
    rpcVersion: YPLUSPLUS_RPC_VERSION, type: "request", requestId: "panel_register",
    method: "ui.settingsPanel.register", payload: { panel },
  });
  assert.equal(parsed.method, "ui.settingsPanel.register");
  assert.throws(() => parseRpcRequest({
    rpcVersion: YPLUSPLUS_RPC_VERSION, type: "request", requestId: "panel_bad",
    method: "ui.settingsPanel.unregister", payload: { panel: {} },
  }), /panelId/);
});

test("registers settings panels through the host facade and disposes on session close", async () => {
  const registered: unknown[] = [];
  let disposed = 0;
  const session = new PluginRpcSession({ facade: { ui: {
    registerSettingsPanel(panel) {
      registered.push(panel);
      return () => { disposed += 1; };
    },
  } } });
  const panel = { id: "general", title: "General", items: [] };
  const result = await session.dispatch({
    rpcVersion: YPLUSPLUS_RPC_VERSION, type: "request", requestId: "panel_register",
    method: "ui.settingsPanel.register", payload: { panel },
  });
  assert.equal(result.ok, true);
  assert.equal(registered.length, 1);
  assert.equal(JSON.stringify(registered[0]), JSON.stringify(panel));
  session.close();
  assert.equal(disposed, 1);
});

test("rejects duplicate settings panel registrations within one RPC session", async () => {
  let calls = 0;
  const session = new PluginRpcSession({ facade: { ui: {
    registerSettingsPanel() { calls += 1; return () => undefined; },
  } } });
  const makeRequest = (requestId: string) => ({
    rpcVersion: YPLUSPLUS_RPC_VERSION, type: "request", requestId,
    method: "ui.settingsPanel.register", payload: { panel: { id: "general", title: "General", items: [] } },
  });
  assert.equal((await session.dispatch(makeRequest("panel_one"))).ok, true);
  const duplicate = await session.dispatch(makeRequest("panel_two"));
  assert.equal(duplicate.ok, false);
  assert.equal(calls, 1);
  session.close();
});


test("dispatches the fixed Hello startup audio request", async () => {
  let played = 0;
  const session = new PluginRpcSession({
    facade: { audio: { playStartup: async () => { played += 1; } } },
  });
  const result = await session.dispatch({
    rpcVersion: YPLUSPLUS_RPC_VERSION,
    type: "request",
    requestId: "audio_1",
    method: "audio.playStartup",
    payload: {},
  });
  assert.equal(result.ok, true);
  assert.equal(played, 1);
  assert.throws(() => parseRpcRequest({
    rpcVersion: YPLUSPLUS_RPC_VERSION,
    type: "request",
    requestId: "audio_2",
    method: "audio.playStartup",
    payload: { url: "https://example.invalid/sound.mp3" },
  }), /takes no arguments/);
});

test("emits the application-ready event to a connected plugin session", () => {
  const session = new PluginRpcSession({ facade: {} });
  const events: unknown[] = [];
  session.setEventSink((event) => events.push(event));
  session.emitApplicationReady(1234);
  assert.deepEqual(events, [{
    rpcVersion: YPLUSPLUS_RPC_VERSION,
    type: "event",
    event: "application.ready",
    payload: { timestamp: 1234 },
  }]);
  session.close();
  session.emitApplicationReady(5678);
  assert.equal(events.length, 1);
});
