/**
 * Persistent, version-scoped plugin capability approvals.
 *
 * Approval records are host-owned data. Malformed or unsafe storage fails
 * closed; this module never imports or executes plugin code.
 */
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const STORE_VERSION = 1 as const;
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$/;

interface ApprovalRecord {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly capabilities: readonly string[];
}

interface ApprovalDocument {
  readonly storeVersion: typeof STORE_VERSION;
  readonly records: readonly ApprovalRecord[];
}

export interface ApprovalStoreOptions {
  /** Explicit path is useful for tests and portable installations. */
  readonly filePath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

export class ApprovalStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApprovalStoreError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateIdentity(pluginId: string, pluginVersion: string): void {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new TypeError("Invalid plugin ID.");
  }
  if (!SEMVER_PATTERN.test(pluginVersion)) {
    throw new TypeError("Invalid plugin version; expected SemVer.");
  }
}

function validateCapabilities(capabilities: readonly string[]): string[] {
  if (!Array.isArray(capabilities)) {
    throw new TypeError("Capabilities must be an array.");
  }
  const unique = new Set<string>();
  for (const capability of capabilities) {
    if (typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability) || capability.length > 128) {
      throw new TypeError("Invalid capability identifier.");
    }
    unique.add(capability);
  }
  return [...unique].sort();
}

function parseDocument(input: unknown): ApprovalDocument {
  if (!isRecord(input) || Object.keys(input).some((key) => !["storeVersion", "records"].includes(key))) {
    throw new ApprovalStoreError("Approval store has an invalid document shape.");
  }
  if (input.storeVersion !== STORE_VERSION || !Array.isArray(input.records)) {
    throw new ApprovalStoreError("Approval store version or records are invalid.");
  }

  const seen = new Set<string>();
  const records: ApprovalRecord[] = [];
  for (const value of input.records) {
    if (!isRecord(value) || Object.keys(value).some((key) =>
      !["pluginId", "pluginVersion", "capabilities"].includes(key))) {
      throw new ApprovalStoreError("Approval store contains an invalid record.");
    }
    if (typeof value.pluginId !== "string" || typeof value.pluginVersion !== "string" ||
        !Array.isArray(value.capabilities)) {
      throw new ApprovalStoreError("Approval store contains an invalid record.");
    }

    try {
      validateIdentity(value.pluginId, value.pluginVersion);
      const capabilities = validateCapabilities(value.capabilities as string[]);
      if (capabilities.length !== value.capabilities.length) {
        throw new ApprovalStoreError("Approval store contains duplicate capabilities.");
      }
      const key = `${value.pluginId}@${value.pluginVersion}`;
      if (seen.has(key)) throw new ApprovalStoreError("Approval store contains duplicate plugin records.");
      seen.add(key);
      records.push(Object.freeze({
        pluginId: value.pluginId,
        pluginVersion: value.pluginVersion,
        capabilities: Object.freeze(capabilities),
      }));
    } catch (error) {
      if (error instanceof ApprovalStoreError) throw error;
      throw new ApprovalStoreError("Approval store contains invalid plugin data.", { cause: error });
    }
  }

  return Object.freeze({
    storeVersion: STORE_VERSION,
    records: Object.freeze(records),
  });
}

function defaultStorePath(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env.XDG_CONFIG_HOME;
  const configHome = configured && isAbsolute(configured)
    ? resolve(configured)
    : join(home, ".config");
  return join(configHome, "yplusplus", "permissions.json");
}

export class PluginApprovalStore {
  readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: ApprovalStoreOptions = {}) {
    this.filePath = resolve(options.filePath ?? defaultStorePath(options.env ?? process.env, options.home ?? homedir()));
  }

  private async readDocument(): Promise<ApprovalDocument> {
    let info;
    try {
      info = await lstat(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return Object.freeze({ storeVersion: STORE_VERSION, records: Object.freeze([]) });
      }
      throw new ApprovalStoreError("Unable to inspect approval store.", { cause: error });
    }

    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ApprovalStoreError("Approval store must be a regular, non-symlink file.");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new ApprovalStoreError("Approval store permissions are too broad; expected mode 0600.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      throw new ApprovalStoreError("Approval store is unreadable or contains invalid JSON.", { cause: error });
    }
    return parseDocument(parsed);
  }

  async getApprovedPermissions(pluginId: string, pluginVersion: string): Promise<ReadonlySet<string>> {
    validateIdentity(pluginId, pluginVersion);
    const document = await this.readDocument();
    const record = document.records.find((item) =>
      item.pluginId === pluginId && item.pluginVersion === pluginVersion);
    return new Set(record?.capabilities ?? []);
  }

  private async mutate(operation: (records: ApprovalRecord[]) => ApprovalRecord[]): Promise<void> {
    const run = this.queue.then(async () => {
      const current = await this.readDocument();
      const nextRecords = operation(current.records.map((record) => ({
        ...record,
        capabilities: [...record.capabilities],
      })));
      const document: ApprovalDocument = Object.freeze({
        storeVersion: STORE_VERSION,
        records: Object.freeze(nextRecords.map((record) => Object.freeze({
          pluginId: record.pluginId,
          pluginVersion: record.pluginVersion,
          capabilities: Object.freeze(validateCapabilities(record.capabilities)),
        })).filter((record) => record.capabilities.length > 0)),
      });
      await this.writeDocument(document);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async writeDocument(document: ApprovalDocument): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const dirInfo = await lstat(directory);
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      throw new ApprovalStoreError("Approval store directory must be a regular, non-symlink directory.");
    }
    await chmodDirectory(directory);

    const temporary = join(directory, `.permissions-${randomBytes(8).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(document, null, 2) + "\\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, this.filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new ApprovalStoreError("Unable to atomically write approval store.", { cause: error });
    }
  }

  /** Add explicit grants for one exact plugin release. */
  async grantPermissions(pluginId: string, pluginVersion: string, capabilities: readonly string[]): Promise<void> {
    validateIdentity(pluginId, pluginVersion);
    const additions = validateCapabilities(capabilities);
    if (additions.length === 0) return;
    await this.mutate((records) => {
      const existing = records.find((record) =>
        record.pluginId === pluginId && record.pluginVersion === pluginVersion);
      if (existing) {
        existing.capabilities = [...new Set([...existing.capabilities, ...additions])].sort();
      } else {
        records.push({ pluginId, pluginVersion, capabilities: additions });
      }
      return records;
    });
  }

  /** Revoke selected grants, or every grant when capabilities is omitted. */
  async revokePermissions(
    pluginId: string,
    pluginVersion: string,
    capabilities?: readonly string[],
  ): Promise<void> {
    validateIdentity(pluginId, pluginVersion);
    const removals = capabilities === undefined ? undefined : new Set(validateCapabilities(capabilities));
    await this.mutate((records) => records.flatMap((record) => {
      if (record.pluginId !== pluginId || record.pluginVersion !== pluginVersion) return [record];
      if (!removals) return [];
      return [{
        ...record,
        capabilities: record.capabilities.filter((capability) => !removals.has(capability)),
      }];
    }));
  }

  /** Remove every version's approvals for a plugin ID. */
  async revokePlugin(pluginId: string): Promise<void> {
    if (!PLUGIN_ID_PATTERN.test(pluginId)) throw new TypeError("Invalid plugin ID.");
    await this.mutate((records) => records.filter((record) => record.pluginId !== pluginId));
  }
}

async function chmodDirectory(directory: string): Promise<void> {
  const { chmod } = await import("node:fs/promises");
  await chmod(directory, 0o700);
}
