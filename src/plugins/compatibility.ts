/**
 * Plugin API compatibility policy.
 *
 * Manifest format compatibility is handled by manifest validation. This
 * module checks the independent plugin API generation before approval or
 * initialization. It performs no filesystem access and has no side effects.
 */

import type { PluginManifestV1 } from "./manifest.js";

/** API generation currently implemented by the Y++ host. */
export const YPLUSPLUS_PLUGIN_API_VERSION = 1 as const;

export type PluginCompatibilityFailureCode = "unsupported-api-version";

export interface PluginCompatibilityFailure {
  readonly code: PluginCompatibilityFailureCode;
  readonly message: string;
  readonly expectedApiVersion: number;
  readonly receivedApiVersion: number;
}

export type PluginCompatibilityResult =
  | {
      readonly compatible: true;
      readonly pluginApiVersion: number;
      readonly hostApiVersion: number;
    }
  | {
      readonly compatible: false;
      readonly pluginApiVersion: number;
      readonly hostApiVersion: number;
      readonly failure: PluginCompatibilityFailure;
    };

/**
 * API generations require an exact match. A newer host may intentionally
 * retain older generations later, but that must be an explicit host policy
 * rather than an assumption that all generations are backward compatible.
 */
export function checkPluginCompatibility(
  manifest: Pick<PluginManifestV1, "apiVersion">,
  hostApiVersion: number = YPLUSPLUS_PLUGIN_API_VERSION,
): PluginCompatibilityResult {
  if (!Number.isSafeInteger(hostApiVersion) || hostApiVersion < 1) {
    throw new RangeError("Host API version must be a positive safe integer.");
  }

  if (manifest.apiVersion === hostApiVersion) {
    return Object.freeze({
      compatible: true,
      pluginApiVersion: manifest.apiVersion,
      hostApiVersion,
    });
  }

  const failure: PluginCompatibilityFailure = Object.freeze({
    code: "unsupported-api-version",
    message: `Plugin targets Y++ API version ${manifest.apiVersion}; this host supports version ${hostApiVersion}.`,
    expectedApiVersion: hostApiVersion,
    receivedApiVersion: manifest.apiVersion,
  });

  return Object.freeze({
    compatible: false,
    pluginApiVersion: manifest.apiVersion,
    hostApiVersion,
    failure,
  });
}
