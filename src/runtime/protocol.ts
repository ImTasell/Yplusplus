/**
 * Versioned, transport-neutral Y++ plugin RPC message contract.
 * Messages are untrusted data. Parsing copies only bounded JSON-like values.
 */

export const YPLUSPLUS_RPC_VERSION = 1 as const;
export const RPC_MAX_MESSAGE_BYTES = 16 * 1024;
export const RPC_MAX_DEPTH = 8;
export const RPC_MAX_NODES = 256;

export type RpcMethod = "capabilities.notifications.show";

export interface RpcRequest {
  readonly rpcVersion: typeof YPLUSPLUS_RPC_VERSION;
  readonly type: "request";
  readonly requestId: string;
  readonly method: RpcMethod;
  readonly payload: Readonly<{ title: string; message: string }>;
}

export interface RpcSuccessResponse {
  readonly rpcVersion: typeof YPLUSPLUS_RPC_VERSION;
  readonly type: "response";
  readonly requestId: string;
  readonly ok: true;
  readonly result: null;
}

export interface RpcErrorResponse {
  readonly rpcVersion: typeof YPLUSPLUS_RPC_VERSION;
  readonly type: "response";
  readonly requestId: string;
  readonly ok: false;
  readonly error: Readonly<{
    code: "INVALID_MESSAGE" | "UNSUPPORTED_VERSION" | "UNKNOWN_METHOD" |
      "CAPABILITY_DENIED" | "RATE_LIMITED" | "REQUEST_TIMEOUT" | "INTERNAL_ERROR";
    message: string;
  }>;
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;

export class RpcProtocolError extends Error {
  readonly code: "INVALID_MESSAGE" | "UNSUPPORTED_VERSION" | "UNKNOWN_METHOD";
  constructor(code: RpcProtocolError["code"], message: string) {
    super(message);
    this.name = "RpcProtocolError";
    this.code = code;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Copy untrusted structured-clone data into bounded plain JSON data. */
function copyJsonValue(value: unknown, depth: number, budget: { nodes: number }): unknown {
  budget.nodes += 1;
  if (budget.nodes > RPC_MAX_NODES || depth > RPC_MAX_DEPTH) {
    throw new RpcProtocolError("INVALID_MESSAGE", "RPC payload exceeds structural limits.");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > RPC_MAX_MESSAGE_BYTES) {
      throw new RpcProtocolError("INVALID_MESSAGE", "RPC string exceeds the message limit.");
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new RpcProtocolError("INVALID_MESSAGE", "RPC arrays must be plain arrays.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)))) {
      throw new RpcProtocolError("INVALID_MESSAGE", "RPC arrays may not contain extra properties.");
    }
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new RpcProtocolError("INVALID_MESSAGE", "RPC arrays must be dense data arrays.");
      }
      output.push(copyJsonValue(descriptor.value, depth + 1, budget));
    }
    return Object.freeze(output);
  }
  if (record(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        throw new RpcProtocolError("INVALID_MESSAGE", "RPC objects may not contain symbol keys.");
      }
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new RpcProtocolError("INVALID_MESSAGE", "RPC objects must contain enumerable data properties only.");
      }
      output[key] = copyJsonValue(descriptor.value, depth + 1, budget);
    }
    return Object.freeze(output);
  }
  throw new RpcProtocolError("INVALID_MESSAGE", "RPC payload contains a non-JSON value.");
}

export function parseRpcRequest(input: unknown): RpcRequest {
  if (!record(input)) {
    throw new RpcProtocolError("INVALID_MESSAGE", "RPC request must be a plain object.");
  }
  const copied = copyJsonValue(input, 0, { nodes: 0 }) as Record<string, unknown>;
  const encoded = JSON.stringify(copied);
  if (new TextEncoder().encode(encoded).byteLength > RPC_MAX_MESSAGE_BYTES) {
    throw new RpcProtocolError("INVALID_MESSAGE", "RPC message exceeds 16 KiB.");
  }
  const keys = Object.keys(copied).sort();
  if (keys.join(",") !== "method,payload,requestId,rpcVersion,type") {
    throw new RpcProtocolError("INVALID_MESSAGE", "RPC request contains missing or unknown fields.");
  }
  if (copied.rpcVersion !== YPLUSPLUS_RPC_VERSION) {
    throw new RpcProtocolError("UNSUPPORTED_VERSION", "Unsupported Y++ RPC protocol version.");
  }
  if (copied.type !== "request") {
    throw new RpcProtocolError("INVALID_MESSAGE", "Expected an RPC request envelope.");
  }
  if (typeof copied.requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(copied.requestId)) {
    throw new RpcProtocolError("INVALID_MESSAGE", "Invalid RPC request ID.");
  }
  if (copied.method !== "capabilities.notifications.show") {
    throw new RpcProtocolError("UNKNOWN_METHOD", "RPC method is not supported.");
  }
  if (!record(copied.payload)) {
    throw new RpcProtocolError("INVALID_MESSAGE", "RPC payload must be an object.");
  }
  const payloadKeys = Object.keys(copied.payload).sort();
  if (payloadKeys.join(",") !== "message,title" ||
      typeof copied.payload.title !== "string" ||
      typeof copied.payload.message !== "string") {
    throw new RpcProtocolError("INVALID_MESSAGE", "Notification payload must contain only string title and message fields.");
  }
  return Object.freeze({
    rpcVersion: YPLUSPLUS_RPC_VERSION,
    type: "request",
    requestId: copied.requestId,
    method: "capabilities.notifications.show",
    payload: Object.freeze({
      title: copied.payload.title,
      message: copied.payload.message,
    }),
  });
}

export function rpcSuccess(requestId: string): RpcSuccessResponse {
  return Object.freeze({
    rpcVersion: YPLUSPLUS_RPC_VERSION,
    type: "response",
    requestId,
    ok: true,
    result: null,
  });
}

export function rpcFailure(
  requestId: string,
  code: RpcErrorResponse["error"]["code"],
  message: string,
): RpcErrorResponse {
  return Object.freeze({
    rpcVersion: YPLUSPLUS_RPC_VERSION,
    type: "response",
    requestId,
    ok: false,
    error: Object.freeze({ code, message: message.slice(0, 240) }),
  });
}
