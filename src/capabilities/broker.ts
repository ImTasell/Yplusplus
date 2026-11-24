/**
 * Narrow capability facade for Y++ plugins.
 *
 * This broker contains no Electron or Node APIs. Trusted host adapters are
 * injected by the eventual runtime integration; plugin code is not loaded
 * or executed by this module.
 */
import type { ManagedPlugin, PluginApprovalProvider } from "../plugins/manager.js";

export interface NotificationRequest {
  readonly title: string;
  readonly message: string;
}

export type NotificationAdapter = (
  plugin: Readonly<{ id: string; version: string }>,
  request: NotificationRequest,
) => void | Promise<void>;

export interface CapabilityBrokerOptions {
  /** Reads current host-owned approvals; checked again on every operation. */
  readonly getApprovedPermissions: PluginApprovalProvider;
  /** Trusted host implementation, e.g. an adapter around Electron Notification. */
  readonly notifications: NotificationAdapter;
}

export interface PluginCapabilityFacade {
  readonly notifications?: Readonly<{
    show(request: NotificationRequest): Promise<void>;
  }>;
}

export class CapabilityDeniedError extends Error {
  readonly capability: string;

  constructor(capability: string, message: string) {
    super(message);
    this.name = "CapabilityDeniedError";
    this.capability = capability;
  }
}

function normalizeNotification(input: unknown): NotificationRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Notification request must be an object.");
  }

  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.some((key) => typeof key !== "string" || !["title", "message"].includes(key))) {
    throw new TypeError("Notification request may contain only title and message.");
  }

  const titleDescriptor = Object.getOwnPropertyDescriptor(input, "title");
  const messageDescriptor = Object.getOwnPropertyDescriptor(input, "message");
  if (!titleDescriptor || !("value" in titleDescriptor) ||
      !messageDescriptor || !("value" in messageDescriptor)) {
    throw new TypeError("Notification title and message must be own data properties.");
  }

  const title: unknown = titleDescriptor.value;
  const message: unknown = messageDescriptor.value;
  if (typeof title !== "string" || typeof message !== "string") {
    throw new TypeError("Notification title and message must be strings.");
  }
  const normalizedTitle = title.trim();
  const normalizedMessage = message.trim();
  if (normalizedTitle.length === 0 || normalizedTitle.length > 80) {
    throw new RangeError("Notification title must contain 1–80 characters.");
  }
  if (normalizedMessage.length === 0 || normalizedMessage.length > 500) {
    throw new RangeError("Notification message must contain 1–500 characters.");
  }

  return Object.freeze({ title: normalizedTitle, message: normalizedMessage });
}

/**
 * Build a least-privilege facade for a READY plugin snapshot.
 *
 * The plugin identity and requested permissions come from the validated
 * host manager report, never from arguments supplied by plugin code.
 */
export async function createPluginCapabilityFacade(
  plugin: ManagedPlugin,
  options: CapabilityBrokerOptions,
): Promise<PluginCapabilityFacade> {
  if (plugin.state !== "READY" || !plugin.compatibility.compatible ||
      plugin.compatibility.pluginApiVersion !== plugin.compatibility.hostApiVersion) {
    throw new CapabilityDeniedError(
      "plugin.lifecycle",
      "Only compatible plugins in READY state can receive a capability facade.",
    );
  }

  const requested = new Set(plugin.requestedPermissions);
  const approved = await options.getApprovedPermissions(plugin.id, plugin.version);
  const notificationsApproved =
    requested.has("ui.notifications") && approved.has("ui.notifications");

  if (!notificationsApproved) {
    return Object.freeze({});
  }

  const show = async (input: NotificationRequest): Promise<void> => {
    // Re-read approval at call time so revocation is effective without
    // requiring a plugin reload or trusting a stale manager snapshot.
    const current = await options.getApprovedPermissions(plugin.id, plugin.version);
    if (!current.has("ui.notifications")) {
      throw new CapabilityDeniedError(
        "ui.notifications",
        "The host has not approved this capability or its approval was revoked.",
      );
    }
    const request = normalizeNotification(input);
    await options.notifications(
      Object.freeze({ id: plugin.id, version: plugin.version }),
      request,
    );
  };

  return Object.freeze({
    notifications: Object.freeze({ show }),
  });
}
