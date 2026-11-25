/**
 * MessagePort transport adapter for one host-authenticated plugin RPC session.
 *
 * The caller must create/bind the port pair and session from trusted host state.
 * No plugin identity is accepted over the wire.
 */
import type { PluginRpcSession } from "./rpc-session.js";
import { rpcFailure } from "./protocol.js";

export interface RpcMessagePort {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  start(): void;
  close(): void;
}

export interface RpcPortTransport {
  readonly closed: boolean;
  close(): void;
}

export function bindRpcMessagePort(
  port: RpcMessagePort,
  session: PluginRpcSession,
): RpcPortTransport {
  let closed = false;
  session.setEventSink((event) => { if (!closed) port.postMessage(event); });

  const close = (): void => {
    if (closed) return;
    closed = true;
    port.removeEventListener("message", onMessage);
    session.close();
    port.close();
  };

  const onMessage = (event: { readonly data: unknown }): void => {
    if (closed) return;
    void session.dispatch(event.data).then((response) => {
      if (!closed) port.postMessage(response);
    }).catch(() => {
      if (!closed) {
        port.postMessage(rpcFailure("invalid", "INTERNAL_ERROR", "RPC transport dispatch failed."));
      }
    });
  };

  port.addEventListener("message", onMessage);
  port.start();

  return Object.freeze({
    get closed() { return closed; },
    close,
  });
}
