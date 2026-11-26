import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { YPLUSPLUS_PRELOAD_SOURCE } from "../src/preload-source.js";

type PreloadResult = {
  exposed: boolean;
  api: {
    version: string;
    runtime: string;
    ready: boolean;
    getStatus: () => { ready: boolean; version: string; origin: string };
  } | undefined;
  errors: unknown[];
};

function evaluatePreload(url: string, isMainFrame = true): PreloadResult {
  let api: PreloadResult["api"];
  const errors: unknown[] = [];

  runInNewContext(YPLUSPLUS_PRELOAD_SOURCE, {
    URL,
    location: { href: url },
    process: { isMainFrame },
    require: (id: string) => {
      assert.equal(id, "electron");
      return {
        contextBridge: {
          exposeInMainWorld: (key: string, value: PreloadResult["api"]) => {
            assert.equal(key, "yplusplus");
            api = value;
          }
        }
      };
    },
    console: { error: (...args: unknown[]) => errors.push(args) }
  });

  return { exposed: api !== undefined, api, errors };
}

test("exposes the bridge on each exact HTTPS Yapper/Yapin origin", () => {
  for (const url of [
    "https://www.yapper.website/",
    "https://yapper.website/",
    "https://www.yapin.gg/",
    "https://yapin.gg/"
  ]) {
    const result = evaluatePreload(url);
    assert.equal(result.exposed, true, url);
    assert.equal(result.api?.ready, true, url);
    assert.equal(result.api?.version, "0.1.0", url);
    assert.equal("settingsPage" in (result.api as object), false, "private IPC helpers are not exposed to website JavaScript");
    assert.deepEqual(JSON.parse(JSON.stringify(result.api?.getStatus())), {
      ready: true,
      version: "0.1.0",
      origin: new URL(url).origin
    });
    assert.deepEqual(result.errors, []);
  }
});

test("does not expose the bridge to external sign-in and unrelated sites", () => {
  for (const url of [
    "https://accounts.google.com/",
    "https://discord.com/oauth2/authorize",
    "https://github.com/login/oauth/authorize",
    "https://login.microsoftonline.com/",
    "https://example.com/",
    "https://evil-yapper.website/",
    "https://yapper.website.evil.example/",
    "https://not-yapper.website/"
  ]) {
    const result = evaluatePreload(url);
    assert.equal(result.exposed, false, url);
    assert.deepEqual(result.errors, []);
  }
});

test("requires HTTPS even when the hostname is allowlisted", () => {
  for (const url of [
    "http://www.yapper.website/",
    "http://yapper.website/",
    "http://www.yapin.gg/",
    "http://yapin.gg/"
  ]) {
    assert.equal(evaluatePreload(url).exposed, false, url);
  }
});

test("does not expose the bridge in child frames on an allowed origin", () => {
  const result = evaluatePreload("https://www.yapper.website/embed", false);
  assert.equal(result.exposed, false);
  assert.deepEqual(result.errors, []);
});

test("fails closed for non-web and malformed document URLs", () => {
  for (const url of ["about:blank", "file:///tmp/login.html", "not a URL"]) {
    const result = evaluatePreload(url);
    assert.equal(result.exposed, false, url);
    if (url === "not a URL") {
      assert.equal(result.errors.length, 1);
    } else {
      assert.deepEqual(result.errors, []);
    }
  }
});
