/**
 * Public, transport-neutral Y++ Plugin API v1 contract.
 *
 * These interfaces describe the supported plugin-facing surface. They do not
 * grant capabilities or provide a runtime implementation. The host must
 * construct the API from the plugin's validated manifest and current grants.
 */

export const YPLUSPLUS_API_VERSION = 1 as const;

export interface PluginIdentity {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: typeof YPLUSPLUS_API_VERSION;
}

export interface Logger {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void;
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface NotificationRequest {
  readonly title: string;
  readonly message: string;
}

export interface NotificationsAPI {
  show(request: NotificationRequest): Promise<void>;
}

export interface AudioAPI {
  /** Play the user's selected Hello! startup audio. No path or URL is accepted. */
  playStartup(): Promise<void>;
}

export type SettingValue = string | number | boolean;

export interface SettingsAPI {
  get<T extends SettingValue>(key: string, defaultValue: T): Promise<T>;
  set<T extends SettingValue>(key: string, value: T): Promise<void>;
  onChange<T extends SettingValue>(
    key: string,
    listener: (value: T) => void,
  ): () => void;
}

export interface ToggleSettingItem {
  readonly type: "toggle";
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly defaultValue: boolean;
}

export interface TextSettingItem {
  readonly type: "text";
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly defaultValue: string;
  readonly placeholder?: string;
  readonly maxLength?: number;
}

export interface NumberSettingItem {
  readonly type: "number";
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly defaultValue: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export interface SelectSettingItem {
  readonly type: "select";
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly defaultValue: string;
  readonly options: readonly {
    readonly label: string;
    readonly value: string;
  }[];
}

export type SettingsPanelItem =
  | ToggleSettingItem
  | TextSettingItem
  | NumberSettingItem
  | SelectSettingItem;

export interface SettingsPanelDefinition {
  /** Stable, plugin-local identifier. */
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly icon?: string;
  readonly items: readonly SettingsPanelItem[];
}

export interface UIAPI {
  /**
   * Register a declarative settings panel. The host validates and renders the
   * definition; plugin code never runs in the Yapin renderer.
   * Returns an idempotent disposer for the registration.
   */
  registerSettingsPanel(panel: SettingsPanelDefinition): () => void;
}

export interface PluginEventMap {
  "application.ready": Readonly<{ timestamp: number }>;
  "application.will-quit": Readonly<{ timestamp: number }>;
}

export interface EventsAPI {
  on<K extends keyof PluginEventMap>(
    event: K,
    listener: (payload: PluginEventMap[K]) => void,
  ): () => void;
}

export interface YPlusPlusAPI {
  readonly plugin: PluginIdentity;
  readonly logger: Logger;
  readonly notifications: NotificationsAPI;
  readonly audio?: AudioAPI;
  readonly settings: SettingsAPI;
  readonly ui: UIAPI;
  readonly events: EventsAPI;

  /** Register cleanup to run when this plugin instance is unloaded. */
  onCleanup(cleanup: () => void | Promise<void>): void;
}

/** Entry point contract for a bundled Y++ plugin module. */
export interface YPlusPlusPlugin {
  activate(api: YPlusPlusAPI): void | (() => void | Promise<void>) |
    Promise<void | (() => void | Promise<void>)>;
}
