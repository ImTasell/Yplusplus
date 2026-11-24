/**
 * Persistent explicit trust decisions for exact plugin releases.
 *
 * Trust is separate from capability approval: trusting a plugin permits its
 * entry point to run, but grants no capabilities by itself.
 */
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const VERSION = 1 as const;
const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

interface TrustRecord { readonly pluginId: string; readonly pluginVersion: string; }
interface TrustDocument { readonly storeVersion: typeof VERSION; readonly trusted: readonly TrustRecord[]; }

export interface PluginTrustStoreOptions {
  readonly filePath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

function validate(pluginId: string, pluginVersion: string): void {
  if (!ID.test(pluginId)) throw new TypeError("Invalid plugin ID.");
  if (!SEMVER.test(pluginVersion)) throw new TypeError("Invalid plugin version; expected SemVer.");
}

function parse(input: unknown): TrustDocument {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid trust document.");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["storeVersion", "trusted"].includes(key)) ||
      value.storeVersion !== VERSION || !Array.isArray(value.trusted)) throw new Error("Invalid trust document.");
  const seen = new Set<string>();
  const trusted: TrustRecord[] = [];
  for (const item of value.trusted) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("Invalid trust record.");
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["pluginId", "pluginVersion"].includes(key)) ||
        typeof record.pluginId !== "string" || typeof record.pluginVersion !== "string") throw new Error("Invalid trust record.");
    validate(record.pluginId, record.pluginVersion);
    const key = record.pluginId + "@" + record.pluginVersion;
    if (seen.has(key)) throw new Error("Duplicate trust record.");
    seen.add(key);
    trusted.push(Object.freeze({ pluginId: record.pluginId, pluginVersion: record.pluginVersion }));
  }
  return Object.freeze({ storeVersion: VERSION, trusted: Object.freeze(trusted) });
}

function defaultPath(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env.XDG_CONFIG_HOME;
  const base = configured && isAbsolute(configured) ? resolve(configured) : join(home, ".config");
  return join(base, "yplusplus", "trusted-plugins.json");
}

export class PluginTrustStore {
  readonly filePath: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: PluginTrustStoreOptions = {}) {
    this.filePath = resolve(options.filePath ?? defaultPath(options.env ?? process.env, options.home ?? homedir()));
  }

  async #read(): Promise<TrustDocument> {
    try {
      const info = await lstat(this.filePath);
      if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
        throw new Error("Trust store must be a private regular file (mode 0600).");
      }
      return parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ storeVersion: VERSION, trusted: Object.freeze([]) });
      throw new Error("Unable to read plugin trust store; refusing to trust plugins.", { cause: error });
    }
  }

  async isTrusted(pluginId: string, pluginVersion: string): Promise<boolean> {
    validate(pluginId, pluginVersion);
    await this.#queue;
    const document = await this.#read();
    return document.trusted.some((record) => record.pluginId === pluginId && record.pluginVersion === pluginVersion);
  }

  async trust(pluginId: string, pluginVersion: string): Promise<void> {
    validate(pluginId, pluginVersion);
    await this.#mutate((records) => [...records.filter((r) => r.pluginId !== pluginId || r.pluginVersion !== pluginVersion), { pluginId, pluginVersion }]);
  }

  async untrust(pluginId: string, pluginVersion: string): Promise<void> {
    validate(pluginId, pluginVersion);
    await this.#mutate((records) => records.filter((r) => r.pluginId !== pluginId || r.pluginVersion !== pluginVersion));
  }

  async untrustPlugin(pluginId: string): Promise<void> {
    if (!ID.test(pluginId)) throw new TypeError("Invalid plugin ID.");
    await this.#mutate((records) => records.filter((r) => r.pluginId !== pluginId));
  }

  async #mutate(update: (records: TrustRecord[]) => TrustRecord[]): Promise<void> {
    const run = this.#queue.then(async () => {
      const current = await this.#read();
      const trusted = update(current.trusted.map((record) => ({ ...record })))
        .sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.pluginVersion.localeCompare(b.pluginVersion));
      const directory = dirname(this.filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const dirInfo = await lstat(directory);
      if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) throw new Error("Trust store directory must be a non-symlink directory.");
      await chmod(directory, 0o700);
      const temporary = join(directory, `.trusted-${randomBytes(8).toString("hex")}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify({ storeVersion: VERSION, trusted }, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporary, this.filePath);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw new Error("Unable to atomically write plugin trust store.", { cause: error });
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
