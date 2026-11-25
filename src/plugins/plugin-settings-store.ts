/**
 * Host-owned, persistent plugin settings.
 *
 * Settings are isolated by validated plugin ID, stored outside plugin
 * directories, and exposed only through the runtime's narrow API facade.
 */
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type PluginSettingValue = string | number | boolean;

export interface PluginSettingsStoreOptions {
  readonly directory: string;
}

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SETTING_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_STRING_LENGTH = 8 * 1024;
const DOCUMENT_VERSION = 1 as const;

interface SettingsDocument {
  readonly version: typeof DOCUMENT_VERSION;
  readonly values: Record<string, PluginSettingValue>;
}

function validatePluginId(pluginId: string): void {
  if (typeof pluginId !== "string" || !PLUGIN_ID.test(pluginId)) {
    throw new TypeError("Invalid plugin ID.");
  }
}

function validateKey(key: string): void {
  if (typeof key !== "string" || !SETTING_KEY.test(key)) {
    throw new TypeError("Setting keys must be 1–128 safe ASCII characters.");
  }
}

function validateValue(value: unknown): asserts value is PluginSettingValue {
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) throw new RangeError("Setting strings may not exceed 8192 characters.");
    return;
  }
  if (typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  throw new TypeError("Settings must be strings, finite numbers, or booleans.");
}

function emptyDocument(): SettingsDocument {
  return { version: DOCUMENT_VERSION, values: Object.create(null) as Record<string, PluginSettingValue> };
}

function parseDocument(input: unknown): SettingsDocument {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Settings document must be an object.");
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "values,version" ||
      record.version !== DOCUMENT_VERSION ||
      typeof record.values !== "object" || record.values === null || Array.isArray(record.values)) {
    throw new Error("Invalid plugin settings document.");
  }
  const values: Record<string, PluginSettingValue> = Object.create(null) as Record<string, PluginSettingValue>;
  for (const [key, value] of Object.entries(record.values)) {
    validateKey(key);
    validateValue(value);
    values[key] = value;
  }
  return { version: DOCUMENT_VERSION, values };
}

/**
 * A single store instance is shared by the host. Plugin code must never receive
 * this object directly; the host binds pluginId before creating its API facade.
 */
export class PluginSettingsStore {
  readonly directory: string;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #listeners = new Map<string, Set<(value: PluginSettingValue) => void>>();

  constructor(options: PluginSettingsStoreOptions) {
    if (!options || typeof options.directory !== "string" || options.directory.length === 0) {
      throw new TypeError("A settings directory is required.");
    }
    this.directory = resolve(options.directory);
  }

  #file(pluginId: string): string {
    validatePluginId(pluginId);
    return join(this.directory, `${pluginId}.json`);
  }

  async #read(pluginId: string): Promise<SettingsDocument> {
    const file = this.#file(pluginId);
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
        throw new Error("Plugin settings must be a private regular file (mode 0600).");
      }
      return parseDocument(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument();
      throw new Error(`Unable to read settings for plugin ${pluginId}; refusing to overwrite them.`, { cause: error });
    }
  }

  async #ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Plugin settings directory must be a non-symlink directory.");
    }
    await chmod(this.directory, 0o700);
  }

  async #write(pluginId: string, document: SettingsDocument): Promise<void> {
    await this.#ensureDirectory();
    const file = this.#file(pluginId);
    const temporary = join(this.directory, `.${pluginId}-${randomBytes(8).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", {
        encoding: "utf8", flag: "wx", mode: 0o600,
      });
      await rename(temporary, file);
      await chmod(file, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new Error("Unable to atomically write plugin settings.", { cause: error });
    }
  }

  async get<T extends PluginSettingValue>(pluginId: string, key: string, defaultValue: T): Promise<T> {
    validatePluginId(pluginId);
    validateKey(key);
    validateValue(defaultValue);
    await (this.#queues.get(pluginId) ?? Promise.resolve());
    const document = await this.#read(pluginId);
    return (Object.hasOwn(document.values, key) ? document.values[key] : defaultValue) as T;
  }

  async set(pluginId: string, key: string, value: PluginSettingValue): Promise<void> {
    validatePluginId(pluginId);
    validateKey(key);
    validateValue(value);
    const previous = this.#queues.get(pluginId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const document = await this.#read(pluginId);
      if (Object.is(document.values[key], value)) return false;
      const values = Object.assign(Object.create(null) as Record<string, PluginSettingValue>, document.values);
      values[key] = value;
      await this.#write(pluginId, { version: DOCUMENT_VERSION, values });
      return true;
    });
    const settled = operation.then(() => undefined, () => undefined);
    this.#queues.set(pluginId, settled);
    let changed: boolean;
    try {
      changed = await operation;
    } finally {
      if (this.#queues.get(pluginId) === settled) this.#queues.delete(pluginId);
    }
    if (changed) {
      for (const listener of [...(this.#listeners.get(`${pluginId}/${key}`) ?? [])]) {
        try { listener(value); } catch { /* subscriber errors cannot fail a persisted write */ }
      }
    }
  }

  subscribe(
    pluginId: string,
    key: string,
    listener: (value: PluginSettingValue) => void,
  ): () => void {
    validatePluginId(pluginId);
    validateKey(key);
    if (typeof listener !== "function") throw new TypeError("A settings listener is required.");
    const subscriptionKey = `${pluginId}/${key}`;
    let listeners = this.#listeners.get(subscriptionKey);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(subscriptionKey, listeners);
    }
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners!.delete(listener);
      if (listeners!.size === 0) this.#listeners.delete(subscriptionKey);
    };
  }
}
