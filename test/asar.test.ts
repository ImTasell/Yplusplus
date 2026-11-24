import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { encodeAsar, makeIntegrity, parseAsar, readAsarFile } from "../src/asar.js";

function fixtureArchive(): Buffer {
  const packageJson = Buffer.from(JSON.stringify({ name: "fixture", version: "0.0.1" }));
  const payload = Buffer.from("hello from asar");
  const header = {
    files: {
      "package.json": {
        size: packageJson.length,
        offset: "0",
        integrity: makeIntegrity(packageJson)
      },
      "payload.txt": {
        size: payload.length,
        offset: String(packageJson.length),
        integrity: makeIntegrity(payload)
      }
    }
  };
  return encodeAsar(header, Buffer.concat([packageJson, payload]));
}

test("ASAR encoder and parser round-trip file data", () => {
  const archive = parseAsar(fixtureArchive());
  assert.equal(readAsarFile(archive, "payload.txt").toString("utf8"), "hello from asar");
});

test("ASAR reader rejects data that fails its integrity hash", () => {
  const buffer = fixtureArchive();
  buffer[buffer.length - 1] ^= 0xff;
  const archive = parseAsar(buffer);
  assert.throws(() => readAsarFile(archive, "payload.txt"), /integrity check failed/);
});

test("ASAR parser rejects a truncated header", () => {
  assert.throws(() => parseAsar(Buffer.alloc(12)), /too small/);
});

test("integrity metadata uses SHA-256", () => {
  const data = Buffer.from("Y++");
  assert.equal(makeIntegrity(data)?.hash, createHash("sha256").update(data).digest("hex"));
});
