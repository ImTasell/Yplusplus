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
