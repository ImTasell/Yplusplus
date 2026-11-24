/**
 * Filesystem plugin discovery.
 *
 * Discovery reads manifests and verifies entry-point containment. It never
 * imports, evaluates, or executes plugin code.
 */

import {
  lstat,
  readdir,
  realpath,
  stat,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import {
  PLUGIN_MANIFEST_FILE,
  validatePluginManifest,
  type ManifestIssue,
  type PluginManifestV1,
} from "./manifest.js";

export type PluginDiscoveryIssueCode =
  | "invalid-directory"
  | "missing-manifest"
  | "manifest-not-file"
  | "manifest-read"
  | "manifest-json"
  | "manifest-invalid"
  | "entry-missing"
  | "entry-not-file"
  | "entry-escapes-root"
  | "duplicate-id";

export interface PluginDiscoveryIssue {
  readonly code: PluginDiscoveryIssueCode;
  readonly message: string;
  readonly details?: readonly ManifestIssue[];
}

export interface DiscoveredPlugin {
  readonly directory: string;
  readonly manifestPath: string;
  readonly manifest: PluginManifestV1;
}

export interface RejectedPlugin {
  readonly directory: string;
  readonly issues: readonly PluginDiscoveryIssue[];
}

export interface PluginDiscoveryReport {
  readonly root: string;
  readonly plugins: readonly DiscoveredPlugin[];
  readonly rejected: readonly RejectedPlugin[];
}

interface Candidate {
  readonly directory: string;
  readonly manifestPath: string;
  readonly manifest: PluginManifestV1;
}

/**
 * Resolve a declared entry and ensure its real filesystem target remains
 * inside the plugin root. This prevents traversal through symlinks too.
 */
async function validateEntry(
  pluginDirectory: string,
  entry: string,
): Promise<PluginDiscoveryIssue | undefined> {
  const root = await realpath(pluginDirectory);
  const candidate = path.resolve(root, ...entry.split("/"));

  try {
    const resolved = await realpath(candidate);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return {
        code: "entry-escapes-root",
        message: "The entry point resolves outside the plugin directory.",
      };
    }

    const info = await stat(resolved);
    if (!info.isFile()) {
      return {
        code: "entry-not-file",
        message: "The declared entry point is not a regular file.",
      };
    }
    return undefined;
  } catch {
    return {
      code: "entry-missing",
      message: "The declared entry point does not exist or cannot be accessed.",
    };
  }
}

async function inspectPluginDirectory(directory: string): Promise<
  { readonly ok: true; readonly candidate: Candidate } |
  { readonly ok: false; readonly rejected: RejectedPlugin }
> {
  const issues: PluginDiscoveryIssue[] = [];
  const manifestPath = path.join(directory, PLUGIN_MANIFEST_FILE);

  let manifestInfo;
  try {
    manifestInfo = await lstat(manifestPath);
  } catch {
    return {
      ok: false,
      rejected: {
        directory,
        issues: [{ code: "missing-manifest", message: `Missing ${PLUGIN_MANIFEST_FILE}.` }],
      },
    };
  }

  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
    return {
      ok: false,
      rejected: {
        directory,
        issues: [{ code: "manifest-not-file", message: "Manifest must be a regular, non-symlink file." }],
      },
    };
  }

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return {
      ok: false,
      rejected: {
        directory,
        issues: [{ code: "manifest-read", message: "Manifest could not be read." }],
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      ok: false,
      rejected: {
        directory,
        issues: [{ code: "manifest-json", message: "Manifest is not valid JSON." }],
      },
    };
  }

  const validation = validatePluginManifest(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      rejected: {
        directory,
        issues: [{
          code: "manifest-invalid",
          message: "Manifest failed schema validation.",
          details: validation.issues,
        }],
      },
    };
  }

  const entryIssue = await validateEntry(directory, validation.manifest.entry);
  if (entryIssue) issues.push(entryIssue);
  if (issues.length > 0) {
    return { ok: false, rejected: { directory, issues } };
  }

  return {
    ok: true,
    candidate: {
      directory,
      manifestPath,
      manifest: validation.manifest,
    },
  };
}

/**
 * Scan immediate child directories of pluginRoot in stable name order.
 * Invalid plugins are reported individually; one bad plugin does not stop
 * discovery of its siblings. A missing/unreadable root is reported as an
 * exception so callers cannot mistake it for an empty plugin collection.
 */
export async function discoverPlugins(pluginRoot: string): Promise<PluginDiscoveryReport> {
  const root = path.resolve(pluginRoot);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) {
    throw new Error(`Plugin root is not a directory: ${root}`);
  }

  const entries = await readdir(root, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(root, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  const candidates: Candidate[] = [];
  const rejected: RejectedPlugin[] = [];

  for (const directory of directories) {
    const inspected = await inspectPluginDirectory(directory);
    if (inspected.ok) candidates.push(inspected.candidate);
    else rejected.push(inspected.rejected);
  }

  const ids = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const matches = ids.get(candidate.manifest.id) ?? [];
    matches.push(candidate);
    ids.set(candidate.manifest.id, matches);
  }

  const plugins: DiscoveredPlugin[] = [];
  for (const candidate of candidates) {
    const matches = ids.get(candidate.manifest.id) ?? [];
    if (matches.length > 1) {
      rejected.push({
        directory: candidate.directory,
        issues: [{
          code: "duplicate-id",
          message: `Plugin ID "${candidate.manifest.id}" is declared by multiple directories.`,
        }],
      });
    } else {
      plugins.push(candidate);
    }
  }

  return Object.freeze({
    root,
    plugins: Object.freeze(plugins),
    rejected: Object.freeze(rejected),
  });
}
