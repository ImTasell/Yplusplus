import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { YPLUSPLUS_PRELOAD_SOURCE } from "../src/preload-source.js";

type Bridge = {
  version: string;
  runtime: string;
  ready: boolean;
  getStatus: () => { ready: boolean; version: string; origin: string };
};

type DocumentContext = {
  location: { href: string };
  api: Bridge | undefined;
};

function loadDocument(url: string): DocumentContext {
  const location = { href: url };
  let api: Bridge | undefined;

  runInNewContext(YPLUSPLUS_PRELOAD_SOURCE, {
    URL,
    location,
    process: { isMainFrame: true },
    require: (id: string) => {
      assert.equal(id, "electron");
      return {
        contextBridge: {
          exposeInMainWorld: (key: string, value: Bridge) => {
            assert.equal(key, "yplusplus");
            api = value;
          }
        }
      };
    },
    console: { error: () => undefined }
  });

  return { location, api };
}

function statusOf(api: Bridge) {
  return JSON.parse(JSON.stringify(api.getStatus())) as {
    ready: boolean;
    version: string;
    origin: string;
  };
}

test("same-document SPA route and fragment changes retain the existing bridge", () => {
  const document = loadDocument("https://www.yapper.website/");

  assert.ok(document.api);
  const originalBridge = document.api;

  // pushState/replaceState and hash changes do not create a new document.
  document.location.href = "https://www.yapper.website/servers/123?tab=members";
  assert.equal(document.api, originalBridge);
  assert.equal(document.api.ready, true);

  document.location.href = "https://www.yapper.website/servers/123?tab=members#settings";
  assert.equal(document.api, originalBridge);
  assert.deepEqual(statusOf(document.api), {
    ready: true,
    version: "0.1.0",
    origin: "https://www.yapper.website"
  });
});

test("a same-origin reload creates a fresh document and bootstraps a fresh bridge", () => {
  const beforeReload = loadDocument("https://yapper.website/servers/123");
  assert.ok(beforeReload.api);

  // A reload creates a new renderer document context and reruns the registered preload.
  const afterReload = loadDocument("https://yapper.website/servers/123?tab=overview");
  assert.ok(afterReload.api);
  assert.notEqual(afterReload.api, beforeReload.api);
  assert.equal(afterReload.api.ready, true);
  assert.deepEqual(statusOf(afterReload.api), {
    ready: true,
    version: "0.1.0",
    origin: "https://yapper.website"
  });
});

test("cross-origin top-level navigation replaces the document without the Y++ bridge", () => {
  const appDocument = loadDocument("https://www.yapper.website/");
  assert.ok(appDocument.api);

  // The destination is a new top-level document, evaluated against the preload allowlist.
  const externalDocument = loadDocument("https://accounts.google.com/signin");
  assert.equal(externalDocument.api, undefined);
});

test("an external OAuth popup gets its own document context and no Y++ bridge", () => {
  const appWindow = loadDocument("https://www.yapper.website/");
  const popupWindow = loadDocument("https://discord.com/oauth2/authorize");

  assert.ok(appWindow.api);
  assert.equal(popupWindow.api, undefined);
});
