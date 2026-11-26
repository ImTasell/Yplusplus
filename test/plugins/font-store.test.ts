import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FontStore } from "../../src/plugins/font-store.js";

function minimalTtf(): Uint8Array {
  const bytes = new Uint8Array(12);
  new DataView(bytes.buffer).setUint32(0, 0x00010000, false);
  return bytes;
}

test("font library imports, selects, returns, and removes a private TTF", async () => {
  const root = await mkdtemp(join(tmpdir(), "yplusplus-font-store-"));
  const store = new FontStore({ directory: root });
  try {
    const imported = await store.importFont("MyFont.ttf", minimalTtf());
    assert.equal(imported.name, "MyFont");
    assert.equal(imported.active, false);
    assert.equal((await store.list()).length, 1);

    await store.setActive(imported.id);
    const active = await store.getActive();
    assert.equal(active?.id, imported.id);
    assert.equal(active?.family, "YPlusPlusFont_" + imported.id);
    assert.deepEqual(Array.from(active?.bytes ?? []), Array.from(minimalTtf()));

    const metadata = await stat(join(root, "fonts.json"));
    assert.equal(metadata.mode & 0o077, 0);
    const fontFile = join(root, imported.id + ".ttf");
    const fontInfo = await stat(fontFile);
    assert.equal(fontInfo.mode & 0o077, 0);
    assert.deepEqual(await readFile(fontFile), Buffer.from(minimalTtf()));

    await store.remove(imported.id);
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.getActive(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("font library rejects non-TTF, wrong extensions, and oversized files", async () => {
  const root = await mkdtemp(join(tmpdir(), "yplusplus-font-invalid-"));
  const store = new FontStore({ directory: root });
  try {
    await assert.rejects(store.importFont("font.otf", minimalTtf()), /ttf extension/);
    await assert.rejects(store.importFont("font.ttf", new Uint8Array(12)), /TrueType/);
    await assert.rejects(store.importFont("font.ttf", new Uint8Array(12 * 1024 * 1024 + 1)), /12 MiB/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
