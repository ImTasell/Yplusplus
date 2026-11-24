import assert from "node:assert/strict";
import test from "node:test";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { bindRpcMessagePort, type RpcMessagePort } from "../../src/runtime/message-port.js";
import { PluginRpcSession } from "../../src/runtime/rpc-session.js";
import { YPLUSPLUS_RPC_VERSION } from "../../src/runtime/protocol.js";
import type { PluginCapabilityFacade } from "../../src/capabilities/broker.js";

const request = (requestId: string) => ({
  rpcVersion: YPLUSPLUS_RPC_VERSION,
  type: "request",
  requestId,
  method: "capabilities.notifications.show",
  payload: { title: "Transport test", message: "Hello" },
});

function asRpcPort(port: MessagePort): RpcMessagePort {
  return port as unknown as RpcMessagePort;
}

function nextMessage(port: MessagePort): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      port.off("message", onMessage);
      reject(new Error("Timed out waiting for RPC response."));
    }, 1_000);
    const onMessage = (value: unknown) => {
      clearTimeout(timeout);
      resolve(value);
    };
    port.once("message", onMessage);
  });
}

function makeSession(show: () => Promise<void> = async () => undefined): PluginRpcSession {
  const facade: PluginCapabilityFacade = { notifications: { show } };
  return new PluginRpcSession({ facade });
}

test("transports a request over MessageChannel and returns its RPC response", async () => {
  const { port1, port2 } = new MessageChannel();
  const calls: number[] = [];
  const session = makeSession(async () => { calls.push(1); });
  const transport = bindRpcMessagePort(asRpcPort(port1), session);
  const responsePromise = nextMessage(port2);
  port2.postMessage(request("port_req"));
  const response = await responsePromise as { ok: boolean; requestId: string };
  assert.equal(response.ok, true);
  assert.equal(response.requestId, "port_req");
  assert.deepEqual(calls, [1]);
  transport.close();
  port2.close();
});

test("handles concurrent messages independently on one port", async () => {
  const { port1, port2 } = new MessageChannel();
  const transport = bindRpcMessagePort(asRpcPort(port1), makeSession());
  const responsesPromise = new Promise<unknown[]>((resolve) => {
    const responses: unknown[] = [];
    const onMessage = (value: unknown) => {
      responses.push(value);
      if (responses.length === 2) {
        port2.off("message", onMessage);
        resolve(responses);
      }
    };
    port2.on("message", onMessage);
  });
  port2.postMessage(request("one"));
  port2.postMessage(request("two"));
  const responses = await responsesPromise as Array<{ requestId: string; ok: boolean }>;
  assert.deepEqual(responses.map((item) => item.requestId).sort(), ["one", "two"]);
  assert.ok(responses.every((item) => item.ok));
  transport.close();
  port2.close();
});

test("closing the transport closes the port and suppresses late replies", async () => {
  const { port1, port2 } = new MessageChannel();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const transport = bindRpcMessagePort(asRpcPort(port1), makeSession(() => blocked));
  let received = false;
  port2.on("message", () => { received = true; });
  port2.postMessage(request("late"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  transport.close();
  assert.equal(transport.closed, true);
  transport.close();
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(received, false);
  port2.close();
});
