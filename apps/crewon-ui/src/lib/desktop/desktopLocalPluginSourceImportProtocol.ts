export const DESKTOP_LOCAL_PLUGIN_SOURCE_IMPORT_VERSION = 1 as const;

/** Verified metadata only; local filesystem paths remain in the Main process. */
export type DesktopLocalPluginSourcePreview = Readonly<{
  previewId: string;
  expiresAt: number;
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
  title: string;
  description: string;
  totalBytes: number;
  fileCount: number;
  nodeEntry: string | null;
  uiEntry: Readonly<{
    path: string;
    mode: "trustedModule" | "isolatedWeb";
  }> | null;
  publicAssetCandidates: readonly string[];
}>;

/** Explicit consent to the exact preview. Main rechecks every field and byte. */
export type DesktopLocalPluginSourceConfirmation = Readonly<{
  previewId: string;
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
  publicAssets: readonly string[];
  trustNodeExecution: boolean;
  trustUiModule: boolean;
}>;

export type DesktopLocalPluginSourceConfirmed = Readonly<{
  sourceId: string;
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
  restartRequired: boolean;
  /** Approval is already committed even when restarting the local runtime fails. */
  runtimeStatus: "ready" | "restartRequired";
}>;

/** One Native document's current confirmation; never an execution authority. */
export type DesktopLocalPluginSourceImportStatus = Readonly<{
  previewId: string;
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
}> &
  (
    | Readonly<{ state: "pending" }>
    | Readonly<{
        state: "committed";
        result: DesktopLocalPluginSourceConfirmed;
      }>
    | Readonly<{
        state: "failed";
        code: "desktop_plugin_source_import_failed";
      }>
  );

export interface DesktopLocalPluginSourceImportClient {
  readonly version: typeof DESKTOP_LOCAL_PLUGIN_SOURCE_IMPORT_VERSION;
  previewDirectory(): Promise<DesktopLocalPluginSourcePreview | null>;
  confirmPreview(
    request: DesktopLocalPluginSourceConfirmation,
  ): Promise<DesktopLocalPluginSourceConfirmed>;
  cancelPreview(request: Readonly<{ previewId: string }>): Promise<void>;
  subscribeOwnerChanged(listener: () => void): () => void;
  /** Additive readback: older v1 preloads may not expose these methods. */
  readStatus?(
    request: Readonly<{ previewId: string }>,
  ): Promise<DesktopLocalPluginSourceImportStatus | null>;
  subscribeStatusChanged?(listener: () => void): () => void;
}

export type DesktopLocalPluginSourceImportAccess = Readonly<{
  client: DesktopLocalPluginSourceImportClient;
  ownerKey: string;
}>;
