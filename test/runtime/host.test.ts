import assert from "node:assert/strict";
import test from "node:test";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { ManagedPlugin } from "../../src/plugins/manager.js";
import { PluginRuntimeHost, type PluginExecutionHandle } from "../../src/runtime/host.js";
import type { RpcMessagePort } from "../../src/runtime/message-port.js";
import type { PluginRpcSession } from "../../src/runtime/rpc-session.js";

function plugin(overrides: Partial<ManagedPlugin> = {}): ManagedPlugin {
  return {
    id: "dev.example.runtime",
    name: "Runtime fixture",
    version: "1.0.0",
    directory: "/plugins/runtime",
    state: "READY",
    requestedPermissions: [],
    approvedPermissions: [],
    deniedPermissions: [],
    compatibility: { compatible: true, apiVersion: 1, hostApiVersion: 1 } as ManagedPlugin["compatibility"],
    ...overrides,
  };
}

function port(value: MessagePort): RpcMessagePort {
  return value as unknown as RpcMessagePort;
}

function handle() {
  let exitListener: ((reason?: unknown) => void) | undefined;
  let terminated = 0;
  const value: PluginExecutionHandle = {
    terminate: async () => { terminated += 1; },
    onExit: (listener) => {
      exitListener = listener;
      return () => { exitListener = undefined; };
    },
  };
  return {
    value,
    crash: (reason?: unknown) => exitListener?.(reason),
    get terminated() { return terminated; },
  };
}

function setup(start: (pluginPort: RpcMessagePort) => Promise<PluginExecutionHandle>, timeout = 500) {
  const channels: MessageChannel[] = [];
  const runtime = new PluginRuntimeHost({
    createChannel: () => {
      const channel = new MessageChannel();
      channels.push(channel);
      return { hostPort: port(channel.port1), pluginPort: port(channel.port2) };
    },
    createSession: () => ({ dispatch: async () => ({}) } as unknown as PluginRpcSession),
    execution: { start: (_plugin, pluginPort) => start(pluginPort) },
    startupTimeoutMs: timeout,
  });
  return { runtime, channels };
}

test("starts only READY plugins and transitions them to ACTIVE", async () => {
  const worker = handle();
  const { runtime } = setup(async () => worker.value);
  const active = await runtime.start(plugin());
  assert.equal(active.state, "ACTIVE");
  assert.equal(runtime.get("dev.example.runtime")?.state, "ACTIVE");
  await runtime.unload("dev.example.runtime");
  assert.equal(runtime.get("dev.example.runtime")?.state, "UNLOADED");
  assert.equal(worker.terminated, 1);
});

test("rejects plugins that are not READY or compatible", async () => {
  const { runtime } = setup(async () => handle().value);
  await assert.rejects(runtime.start(plugin({ state: "WAITING_FOR_APPROVAL" })), /READY/);
  await assert.rejects(runtime.start(plugin({
    compatibility: { compatible: false } as ManagedPlugin["compatibility"],
  })), /READY/);
});

test("marks startup failures FAILED and closes both channel endpoints", async () => {
  const { runtime, channels } = setup(async () => { throw new Error("worker failed"); });
  await assert.rejects(runtime.start(plugin()), /worker failed/);
  assert.equal(runtime.get("dev.example.runtime")?.state, "FAILED");
  assert.equal(channels[0]?.port1.hasRef(), false);
  assert.equal(channels[0]?.port2.hasRef(), false);
});

test("times out startup and terminates a worker that resolves late", async () => {
  let resolve!: (value: PluginExecutionHandle) => void;
  const lateWorker = handle();
  const { runtime } = setup(() => new Promise((done) => { resolve = done; }), 100);
  await assert.rejects(runtime.start(plugin()), /timed out/);
  assert.equal(runtime.get("dev.example.runtime")?.state, "FAILED");
  resolve(lateWorker.value);
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(lateWorker.terminated, 1);
});

test("unexpected worker exit fails the plugin and revokes its channel", async () => {
  const worker = handle();
  const { runtime } = setup(async () => worker.value);
  await runtime.start(plugin());
  worker.crash(new Error("crashed"));
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(runtime.get("dev.example.runtime")?.state, "FAILED");
  assert.equal(worker.terminated, 1);
});

test("rejects duplicate starts and permits a fresh instance after unload", async () => {
  const workers = [handle(), handle()];
  let index = 0;
  const { runtime } = setup(async () => workers[index++]!.value);
  await runtime.start(plugin());
  await assert.rejects(runtime.start(plugin()), /already has/);
  await runtime.unload("dev.example.runtime");
  const next = await runtime.start(plugin());
  assert.equal(next.state, "ACTIVE");
  assert.equal(index, 2);
});

test("validates startup timeout bounds", () => {
  assert.throws(() => new PluginRuntimeHost({
    createChannel: () => { throw new Error("unused"); },
    createSession: () => { throw new Error("unused"); },
    execution: { start: async () => handle().value },
    startupTimeoutMs: 1,
  }), RangeError);
});
