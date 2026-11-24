import { contextBridge } from "electron";

const ALLOWED_HOSTS = new Set([
  "www.yapper.website",
  "yapper.website",
  "www.yapin.gg",
  "yapin.gg"
]);

const VERSION = "0.1.0";

try {
  const currentUrl = new URL(globalThis.location.href);
  const isAllowedOrigin =
    currentUrl.protocol === "https:" &&
    ALLOWED_HOSTS.has(currentUrl.hostname);

  // Session URL matching is the first gate; these checks are defense in depth.
  if (process.isMainFrame && isAllowedOrigin) {
    contextBridge.exposeInMainWorld("yplusplus", {
      version: VERSION,
      runtime: "yapper-desktop",
      ready: true,
      getStatus: () => ({
        ready: true,
        version: VERSION,
        origin: currentUrl.origin
      })
    });
  }
} catch (error) {
  // A failed Y++ bootstrap must never prevent Yapper's own preload from running.
  console.error("[Y++] Preload initialization failed:", error);
}
