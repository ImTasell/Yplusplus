/**
 * Pure validation for the v1 Y++ plugin manifest.
 *
 * This module deliberately performs no filesystem access and grants no
 * capabilities. Treat manifests as untrusted data.
 */

export const PLUGIN_MANIFEST_FILE = "yplusplus.plugin.json" as const;
export const PLUGIN_MANIFEST_VERSION = 1 as const;

const MANIFEST_KEYS = new Set([
  "manifestVersion",
  "id",
  "name",
  "version",
  "description",
  "apiVersion",
  "entry",
  "permissions",
]);

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface PluginManifestV1 {
  readonly manifestVersion: typeof PLUGIN_MANIFEST_VERSION;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly apiVersion: number;
  readonly entry: string;
  readonly permissions: readonly string[];
}

export interface ManifestIssue {
  readonly path: string;
  readonly code:
    | "type"
    | "required"
    | "unknown-field"
    | "unsupported-version"
    | "format"
    | "range"
    | "duplicate";
  readonly message: string;
}

export type ManifestValidation =
  | { readonly ok: true; readonly manifest: PluginManifestV1 }
  | { readonly ok: false; readonly issues: readonly ManifestIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: ManifestIssue[],
  path: string,
  code: ManifestIssue["code"],
  message: string,
): void {
  issues.push({ path, code, message });
}

function readString(
  record: Record<string, unknown>,
  key: string,
  issues: ManifestIssue[],
  min: number,
  max: number,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    addIssue(issues, key, "required", "Field is required.");
    return undefined;
  }
  if (typeof value !== "string") {
    addIssue(issues, key, "type", "Expected a string.");
    return undefined;
  }
  if (value.length < min || value.length > max || value.trim() !== value) {
    addIssue(issues, key, "range", `Expected ${min}–${max} characters with no surrounding whitespace.`);
    return undefined;
  }
  return value;
}

function isSafeRelativeEntry(entry: string): boolean {
  if (
    entry.length === 0 ||
    entry.startsWith("/") ||
    entry.includes("\\") ||
    /^[A-Za-z]:/.test(entry) ||
    entry.includes("\0")
  ) {
    return false;
  }

  const segments = entry.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 && segment !== "." && segment !== "..",
  );
}

/**
 * Validate and copy an untrusted JSON value into an immutable v1 manifest.
 * Unknown capability names are allowed here; the future capability broker
 * must deny anything it does not explicitly implement.
 */
export function validatePluginManifest(input: unknown): ManifestValidation {
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [{ path: "$", code: "type", message: "Expected a JSON object." }],
    };
  }

  const issues: ManifestIssue[] = [];

  for (const key of Object.keys(input)) {
    if (!MANIFEST_KEYS.has(key)) {
      addIssue(issues, key, "unknown-field", "Unknown field in manifest version 1.");
    }
  }

  const manifestVersion = input.manifestVersion;
  if (manifestVersion === undefined) {
    addIssue(issues, "manifestVersion", "required", "Field is required.");
  } else if (manifestVersion !== PLUGIN_MANIFEST_VERSION) {
    addIssue(
      issues,
      "manifestVersion",
      "unsupported-version",
      `Only manifest version ${PLUGIN_MANIFEST_VERSION} is supported.`,
    );
  }

  const id = readString(input, "id", issues, 1, 128);
  if (id !== undefined && !PLUGIN_ID_PATTERN.test(id)) {
    addIssue(issues, "id", "format", "Use lowercase letters and digits separated by single dots or hyphens.");
  }

  const name = readString(input, "name", issues, 1, 80);
  const version = readString(input, "version", issues, 1, 128);
  if (version !== undefined && !SEMVER_PATTERN.test(version)) {
    addIssue(issues, "version", "format", "Expected a SemVer version.");
  }

  const description = readString(input, "description", issues, 1, 240);

  const apiVersion = input.apiVersion;
  if (apiVersion === undefined) {
    addIssue(issues, "apiVersion", "required", "Field is required.");
  } else if (
    typeof apiVersion !== "number" ||
    !Number.isSafeInteger(apiVersion) ||
    apiVersion < 1
  ) {
    addIssue(issues, "apiVersion", "range", "Expected a positive safe integer.");
  }

  const entry = readString(input, "entry", issues, 1, 240);
  if (entry !== undefined && !isSafeRelativeEntry(entry)) {
    addIssue(issues, "entry", "format", "Expected a safe relative POSIX path without traversal segments.");
  }

  const permissionsValue = input.permissions;
  const permissions: string[] = [];
  if (permissionsValue === undefined) {
    addIssue(issues, "permissions", "required", "Field is required.");
  } else if (!Array.isArray(permissionsValue)) {
    addIssue(issues, "permissions", "type", "Expected an array of capability identifiers.");
  } else {
    const seen = new Set<string>();
    permissionsValue.forEach((permission: unknown, index: number) => {
      const path = `permissions[${index}]`;
      if (typeof permission !== "string") {
        addIssue(issues, path, "type", "Expected a string capability identifier.");
      } else if (permission.length > 128 || !CAPABILITY_PATTERN.test(permission)) {
        addIssue(issues, path, "format", "Expected a lowercase, namespaced capability identifier.");
      } else if (seen.has(permission)) {
        addIssue(issues, path, "duplicate", "Capability is listed more than once.");
      } else {
        seen.add(permission);
        permissions.push(permission);
      }
    });
  }

  if (
    issues.length > 0 ||
    id === undefined ||
    name === undefined ||
    version === undefined ||
    description === undefined ||
    typeof apiVersion !== "number" ||
    entry === undefined
  ) {
    return { ok: false, issues: Object.freeze(issues) };
  }

  const manifest: PluginManifestV1 = Object.freeze({
    manifestVersion: PLUGIN_MANIFEST_VERSION,
    id,
    name,
    version,
    description,
    apiVersion,
    entry,
    permissions: Object.freeze(permissions),
  });

  return { ok: true, manifest };
}
