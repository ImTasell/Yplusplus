/**
 * Persistent per-release enable/disable preferences.
 *
 * This preference controls lifecycle startup only. It never grants execution
 * trust or capabilities; those remain separate host-owned decisions.
 */
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const VERSION = 1 as const;
const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

interface DisabledRelease {
  readonly pluginId: string;
  readonly pluginVersion: string;
}
interface EnableDocument {
  readonly storeVersion: typeof VERSION;
  readonly disabled: readonly DisabledRelease[];
}

function validate(pluginId: string, pluginVersion: string): void {
  if (typeof pluginId !== "string" || !ID.test(pluginId)) throw new TypeError("Invalid plugin ID.");
  if (typeof pluginVersion !== "string" || !SEMVER.test(pluginVersion)) throw new TypeError("Invalid plugin version; expected SemVer.");
}

function parse(input: unknown): EnableDocument {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid plugin enable document.");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "disabled,storeVersion" ||
      value.storeVersion !== VERSION || !Array.isArray(value.disabled)) {
    throw new Error("Invalid plugin enable document.");
  }
  const seen = new Set<string>();
  const disabled: DisabledRelease[] = [];
  for (const item of value.disabled) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("Invalid disabled plugin record.");
    const record = item as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "pluginId,pluginVersion" ||
        typeof record.pluginId !== "string" || typeof record.pluginVersion !== "string") {
      throw new Error("Invalid disabled plugin record.");
    }
    validate(record.pluginId, record.pluginVersion);
    const key = record.pluginId + "@" + record.pluginVersion;
    if (seen.has(key)) throw new Error("Duplicate disabled plugin record.");
    seen.add(key);
    disabled.push(Object.freeze({ pluginId: record.pluginId, pluginVersion: record.pluginVersion }));
  }
  return Object.freeze({ storeVersion: VERSION, disabled: Object.freeze(disabled) });
}

export interface PluginEnabledStoreOptions {
  readonly filePath: string;
}

/** Defaults to enabled to preserve the previous trusted-plugin startup behavior. */
export class PluginEnabledStore {
  readonly filePath: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: PluginEnabledStoreOptions) {
    if (!options || typeof options.filePath !== "string" || options.filePath.length === 0) {
      throw new TypeError("A plugin enable-state file path is required.");
    }
    this.filePath = resolve(options.filePath);
  }

  async #read(): Promise<EnableDocument> {
    try {
      const info = await lstat(this.filePath);
      if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
        throw new Error("Plugin enable-state file must be a private regular file (mode 0600).");
      }
      return parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return Object.freeze({ storeVersion: VERSION, disabled: Object.freeze([]) });
      }
      throw new Error("Unable to read plugin enable state; refusing to change plugin lifecycle.", { cause: error });
    }
  }

  async isEnabled(pluginId: string, pluginVersion: string): Promise<boolean> {
    validate(pluginId, pluginVersion);
    await this.#queue;
    const document = await this.#read();
    return !document.disabled.some((item) => item.pluginId === pluginId && item.pluginVersion === pluginVersion);
  }

  async setEnabled(pluginId: string, pluginVersion: string, enabled: boolean): Promise<void> {
    validate(pluginId, pluginVersion);
    if (typeof enabled !== "boolean") throw new TypeError("Plugin enabled state must be boolean.");
    const operation = this.#queue.then(async () => {
      const current = await this.#read();
      const disabled = current.disabled.filter((item) =>
        item.pluginId !== pluginId || item.pluginVersion !== pluginVersion);
      if (!enabled) disabled.push({ pluginId, pluginVersion });
      disabled.sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.pluginVersion.localeCompare(b.pluginVersion));

      const directory = dirname(this.filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryInfo = await lstat(directory);
      if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
        throw new Error("Plugin enable-state directory must be a non-symlink directory.");
      }
      await chmod(directory, 0o700);
      const temporary = join(directory, `.plugin-enabled-${randomBytes(8).toString("hex")}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify({ storeVersion: VERSION, disabled }, null, 2) + "\n", {
          encoding: "utf8", flag: "wx", mode: 0o600,
        });
        await rename(temporary, this.filePath);
        await chmod(this.filePath, 0o600);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw new Error("Unable to atomically write plugin enable state.", { cause: error });
      }
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }
}
