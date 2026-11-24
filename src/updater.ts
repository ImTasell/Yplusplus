import { createHash, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { inspectAppDir, SUPPORTED_YAPPER_VERSION } from "./patcher.js";
import { installAppImage } from "./managed.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_APPIMAGE_BYTES = 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const OFFICIAL_UPDATE_HOSTS = new Set(["www.yapper.website", "files.yapper.website"]);

export interface UpdateFileInfo {
  url: string;
  sha512: string;
  size?: number;
}

export interface YapperUpdateManifest {
  version: string;
  files: UpdateFileInfo[];
}

export interface YapperUpdateCheck {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  compatible: boolean;
  manifestUrl: string;
  file: UpdateFileInfo & { url: string };
}

export type UpdateFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

function parseScalar(value: string): string {
  const trimmed = value.trim().replace(/\s+#.*$/, "");
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "string") throw new Error("Expected a string YAML scalar.");
    return parsed;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function parseYamlPair(line: string): [string, string] | null {
  const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line.trim());
  return match ? [match[1]!, match[2] ?? ""] : null;
}

function validateVersion(version: string): string {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error(`Update manifest contains an invalid semantic version: ${version}`);
  for (const part of match.slice(1, 4)) {
    if (!Number.isSafeInteger(Number(part))) {
      throw new Error(`Update manifest version component is too large: ${version}`);
    }
  }
  if (match[4] !== undefined) {
    const identifiers = match[4].split(".");
    if (identifiers.some((part) => part === "" || !/^[0-9A-Za-z-]+$/.test(part) || (/^\d+$/.test(part) && part.length > 1 && part.startsWith("0")))) {
      throw new Error(`Update manifest contains an invalid semantic version: ${version}`);
    }
  }
  return version;
}

export function compareVersions(left: string, right: string): number {
  const a = validateVersion(left);
  const b = validateVersion(right);
  const aMatch = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(a)!;
  const bMatch = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(b)!;

  for (let i = 1; i <= 3; i++) {
    const delta = Number(aMatch[i]) - Number(bMatch[i]);
    if (delta !== 0) return Math.sign(delta);
  }

  const aPre = aMatch[4];
  const bPre = bMatch[4];
  if (aPre === undefined && bPre === undefined) return 0;
  if (aPre === undefined) return 1;
  if (bPre === undefined) return -1;

  const aParts = aPre.split(".");
  const bParts = bPre.split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const av = aParts[i];
    const bv = bParts[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return BigInt(av) < BigInt(bv) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function validateOfficialUrl(input: string | URL, base?: URL): URL {
  const url = base ? new URL(input, base) : new URL(input);
  if (
    url.protocol !== "https:" ||
    !OFFICIAL_UPDATE_HOSTS.has(url.hostname) ||
    (url.port !== "" && url.port !== "443") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(`Refusing a non-official or insecure Yapper update URL: ${url.href}`);
  }
  return url;
}

async function fetchFollowingOfficialRedirects(
  initialUrl: string | URL,
  fetcher: UpdateFetcher
): Promise<{ response: Response; finalUrl: URL }> {
  let url = validateOfficialUrl(initialUrl);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetcher(url, {
      redirect: "manual",
      headers: { "User-Agent": "Y++-BOOT/0.1.0" },
      signal: AbortSignal.timeout(15 * 60_000)
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Yapper update server returned a redirect without a Location header.");
      if (redirects === MAX_REDIRECTS) throw new Error("Yapper update server exceeded the redirect limit.");
      url = validateOfficialUrl(location, url);
      continue;
    }

    return { response, finalUrl: url };
  }

  throw new Error("Yapper update redirect limit exceeded.");
}

async function readResponseText(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new Error("Yapper update server returned an empty response body.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(`Yapper update manifest exceeds the ${limit}-byte safety limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString("utf8");
}

export function parseYapperUpdateManifest(source: string): YapperUpdateManifest {
  if (Buffer.byteLength(source, "utf8") > MAX_MANIFEST_BYTES) {
    throw new Error("Yapper update manifest is too large.");
  }

  const root: Record<string, string> = {};
  const files: Record<string, string>[] = [];
  let inFiles = false;
  let currentFile: Record<string, string> | undefined;

  for (const rawLine of source.replace(/\r/g, "").split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed === "---") continue;
    const indent = rawLine.length - rawLine.trimStart().length;

    if (indent === 0) {
      inFiles = false;
      currentFile = undefined;
      const pair = parseYamlPair(rawLine);
      if (!pair) continue;
      const [key, rawValue] = pair;
      if (key === "files" && rawValue.trim() === "") {
        inFiles = true;
      } else {
        root[key] = parseScalar(rawValue);
      }
      continue;
    }

    if (!inFiles) continue;

    if (indent === 2 && trimmed.startsWith("-")) {
      currentFile = {};
      files.push(currentFile);
      const rest = trimmed.slice(1).trim();
      if (rest !== "") {
        const pair = parseYamlPair(rest);
        if (pair) currentFile[pair[0]] = parseScalar(pair[1]);
      }
      continue;
    }

    if (indent >= 4 && currentFile) {
      const pair = parseYamlPair(trimmed);
      if (pair) currentFile[pair[0]] = parseScalar(pair[1]);
    }
  }

  const version = validateVersion(root.version ?? "");
  const parsedFiles: UpdateFileInfo[] = [];

  for (const entry of files) {
    if (!entry.url || !entry.sha512) continue;
    const size = entry.size === undefined ? undefined : Number(entry.size);
    if (size !== undefined && (!Number.isSafeInteger(size) || size <= 0 || size > MAX_APPIMAGE_BYTES)) {
      throw new Error("Yapper update manifest contains an invalid AppImage size.");
    }
    const digest = Buffer.from(entry.sha512, "base64");
    if (digest.length !== 64 || digest.toString("base64") !== entry.sha512) {
      throw new Error("Yapper update manifest contains an invalid SHA-512 checksum.");
    }
    parsedFiles.push(size === undefined
      ? { url: entry.url, sha512: entry.sha512 }
      : { url: entry.url, sha512: entry.sha512, size });
  }

  if (parsedFiles.length === 0 && root.path && root.sha512) {
    const digest = Buffer.from(root.sha512, "base64");
    if (digest.length !== 64 || digest.toString("base64") !== root.sha512) {
      throw new Error("Yapper update manifest contains an invalid legacy SHA-512 checksum.");
    }
    const size = root.size === undefined ? undefined : Number(root.size);
    if (size !== undefined && (!Number.isSafeInteger(size) || size <= 0 || size > MAX_APPIMAGE_BYTES)) {
      throw new Error("Yapper update manifest contains an invalid AppImage size.");
    }
    parsedFiles.push(size === undefined
      ? { url: root.path, sha512: root.sha512 }
      : { url: root.path, sha512: root.sha512, size });
  }

  if (parsedFiles.length === 0) {
    throw new Error("Yapper update manifest does not contain an AppImage file with a SHA-512 checksum.");
  }

  return { version, files: parsedFiles };
}

function readFeedConfiguration(appDir: string): URL {
  const configPath = join(appDir, "resources", "app-update.yml");
  if (!existsSync(configPath)) {
    throw new Error(`Yapper update configuration was not found: ${configPath}`);
  }
  const source = readFileSync(configPath, "utf8");
  const fields: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const pair = parseYamlPair(line);
    if (pair) fields[pair[0]] = parseScalar(pair[1]);
  }
  if (fields.provider !== "generic" || !fields.url) {
    throw new Error("Unsupported Yapper update configuration; expected the verified generic HTTPS provider.");
  }
  const feed = validateOfficialUrl(fields.url);
  if (feed.hostname !== "www.yapper.website" || (feed.pathname !== "/download" && feed.pathname !== "/download/")) {
    throw new Error("Yapper update feed host changed; refusing to use an unresearched update provider.");
  }
  if (!feed.pathname.endsWith("/")) feed.pathname += "/";
  return feed;
}

function selectAppImageFile(manifest: YapperUpdateManifest, feedUrl: URL): UpdateFileInfo & { url: string } {
  const candidates = manifest.files
    .filter(file => new URL(file.url, feedUrl).pathname.toLowerCase().endsWith(".appimage"))
    .map(file => ({ ...file, url: validateOfficialUrl(file.url, feedUrl).href }));

  if (candidates.length === 0) {
    throw new Error("Yapper update manifest does not publish an official AppImage for Linux.");
  }

  const archMatch = candidates.find(file => basename(new URL(file.url).pathname).toLowerCase().includes(process.arch));
  return archMatch ?? candidates[0]!;
}

export async function checkYapperUpdate(
  appDir: string,
  fetcher: UpdateFetcher = fetch
): Promise<YapperUpdateCheck> {
  const inspected = inspectAppDir(appDir);
  if (inspected.name !== "yapper-desktop" || !inspected.patched) {
    throw new Error("Update checks require a patched, managed Yapper AppDir.");
  }

  const feedUrl = readFeedConfiguration(inspected.appDir);
  const channel = process.arch === "x64" ? "latest-linux.yml" : `latest-linux-${process.arch}.yml`;
  const manifestUrl = new URL(channel, feedUrl);
  const { response, finalUrl } = await fetchFollowingOfficialRedirects(manifestUrl, fetcher);
  if (!response.ok) {
    throw new Error(`Yapper update manifest request failed with HTTP ${response.status}.`);
  }
  const manifest = parseYapperUpdateManifest(await readResponseText(response, MAX_MANIFEST_BYTES));
  const appImage = selectAppImageFile(manifest, feedUrl);

  return {
    currentVersion: inspected.version,
    latestVersion: manifest.version,
    available: compareVersions(manifest.version, inspected.version) > 0,
    compatible: manifest.version === SUPPORTED_YAPPER_VERSION,
    manifestUrl: finalUrl.href,
    file: appImage
  };
}

export async function downloadVerifiedAppImage(
  file: UpdateFileInfo & { url: string },
  destination: string,
  fetcher: UpdateFetcher = fetch
): Promise<{ bytes: number; sha512: string }> {
  const url = validateOfficialUrl(file.url);
  mkdirSync(dirname(destination), { recursive: true });
  if (file.size !== undefined && (file.size <= 0 || file.size > MAX_APPIMAGE_BYTES)) {
    throw new Error("Yapper update AppImage size is outside the allowed range.");
  }

  const { response } = await fetchFollowingOfficialRedirects(url, fetcher);
  if (!response.ok) throw new Error(`Yapper AppImage download failed with HTTP ${response.status}.`);
  if (!response.body) throw new Error("Yapper AppImage download returned an empty response body.");

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_APPIMAGE_BYTES) {
      throw new Error("Yapper AppImage response has an invalid or excessive Content-Length.");
    }
    if (file.size !== undefined && declaredLength !== file.size) {
      throw new Error("Yapper AppImage Content-Length does not match the update manifest.");
    }
  }

  const hash = createHash("sha512");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_APPIMAGE_BYTES || (file.size !== undefined && bytes > file.size)) {
        callback(new Error("Yapper AppImage download exceeded its declared or maximum size."));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
      meter,
      createWriteStream(destination, { flags: "wx", mode: 0o755 })
    );

    if (file.size !== undefined && bytes !== file.size) {
      throw new Error("Yapper AppImage download size does not match the update manifest.");
    }

    const actual = hash.digest();
    const expected = Buffer.from(file.sha512, "base64");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error("Yapper AppImage SHA-512 verification failed; the file was discarded.");
    }

    chmodSync(destination, 0o755);
    return { bytes, sha512: actual.toString("base64") };
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  }
}

export type YapperUpdateResult =
  | { status: "up-to-date"; check: YapperUpdateCheck }
  | { status: "updated"; check: YapperUpdateCheck; install: ReturnType<typeof installAppImage> };

export async function updateYapper(
  appDir: string,
  fetcher: UpdateFetcher = fetch
): Promise<YapperUpdateResult> {
  const check = await checkYapperUpdate(appDir, fetcher);
  if (!check.available) return { status: "up-to-date", check };
  if (!check.compatible) {
    throw new Error(
      `Yapper ${check.latestVersion} is available, but this Y++ build only patches ${SUPPORTED_YAPPER_VERSION}; refusing to download or install it.`
    );
  }

  const dataHome = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.startsWith("/")
    ? process.env.XDG_DATA_HOME
    : join(homedir(), ".local", "share");
  const downloadsDir = join(dataHome, "yplusplus", "downloads");
  mkdirSync(downloadsDir, { recursive: true });
  const stagingDir = mkdtempSync(join(downloadsDir, ".yplusplus-update-"));
  const imagePath = join(stagingDir, "Yapper-Update.AppImage");

  try {
    await downloadVerifiedAppImage(check.file, imagePath, fetcher);
    const install = installAppImage(imagePath);
    return { status: "updated", check, install };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
