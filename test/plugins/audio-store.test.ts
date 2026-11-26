import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AudioStore } from "../../src/plugins/audio-store.js";

function mp3Frames(count: number): Uint8Array {
  const frame = Buffer.alloc(417 * count);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 417;
    frame.set([0xff, 0xfb, 0x90, 0x64], offset);
  }
  return new Uint8Array(frame);
}
function oggPage(flags: number, granule: bigint, sequence: number, body: Buffer): Buffer {
  const header = Buffer.alloc(28);
  header.write("OggS", 0, "ascii");
  header[4] = 0;
  header[5] = flags;
  header.writeBigUInt64LE(granule, 6);
  header.writeUInt32LE(1, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = 1;
  header[27] = body.length;
  return Buffer.concat([header, body]);
}
function oggVorbis(granule: bigint): Uint8Array {
  const identification = Buffer.alloc(30);
  identification[0] = 1;
  identification.write("vorbis", 1, "ascii");
  identification.writeUInt32LE(0, 7);
  identification[11] = 2;
  identification.writeUInt32LE(44100, 12);
  identification[28] = 0xb8;
  identification[29] = 1;
  const first = oggPage(2, 0n, 0, identification);
  const last = oggPage(4, granule, 1, Buffer.from([0]));
  return new Uint8Array(Buffer.concat([first, last]));
}

test("audio store accepts MP3 and Ogg, selects a file, and returns validated bytes", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "yplusplus-audio-store-"));
  try {
    const store = new AudioStore({ directory: path.join(temporary, "audio") });
    const mp3 = await store.importAudio("startup.mp3", mp3Frames(2));
    const ogg = await store.importAudio("welcome.ogg", oggVorbis(44100n));
    assert.equal(mp3.format, "mp3");
    assert.equal(ogg.format, "ogg");
    assert.equal((await store.list()).length, 2);

    await store.select(ogg.id);
    const active = await store.getActive();
    assert.ok(active);
    assert.equal(active.id, ogg.id);
    assert.equal(active.mimeType, "audio/ogg");
    assert.equal(active.duration, 1);
    assert.ok(active.bytes instanceof Uint8Array);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("audio store rejects unsupported, malformed, and longer-than-three-second files", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "yplusplus-audio-invalid-"));
  try {
    const store = new AudioStore({ directory: path.join(temporary, "audio") });
    await assert.rejects(store.importAudio("sound.wav", mp3Frames(2)), /valid \.mp3 or \.ogg/);
    const broken = new Uint8Array(128);
    broken.set([0xff, 0xfb, 0x00, 0x00]);
    await assert.rejects(store.importAudio("broken.mp3", broken), /malformed|decodable frames/);
    await assert.rejects(store.importAudio("long.ogg", oggVorbis(132301n)), /no more than 3 seconds/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
