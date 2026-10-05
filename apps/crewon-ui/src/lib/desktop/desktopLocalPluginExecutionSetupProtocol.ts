export const DESKTOP_LOCAL_PLUGIN_EXECUTION_SETUP_VERSION = 1 as const;

/** Public pins only. Paths, actor identity and runtime authority stay in Main. */
export type DesktopLocalPluginExecutionIdentity = Readonly<{
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
  manifestDigest: string;
  implementationDigest: string;
  selectionRevision: number;
  configurationRevision: number;
  configurationDigest: string;
}>;

export type DesktopLocalPluginExecutionNetworkPath =
  | Readonly<{ method: "GET" | "POST"; path: string }>
  | Readonly<{ method: "GET"; operationPathPrefix: string }>;

export type DesktopLocalPluginExecutionPreview =
  DesktopLocalPluginExecutionIdentity &
    Readonly<{
      previewId: string;
      expiresAt: number;
      baseUrl: string;
      preset: "krea2-portrait" | "krea2-character-three-view";
      networkPaths: readonly DesktopLocalPluginExecutionNetworkPath[];
      approvalRequirement: "none";
    }>;

/** Consent refers to one Main-owned preview, never renderer-supplied permissions. */
export type DesktopLocalPluginExecutionConfirmation = Readonly<{
  previewId: string;
  approveExecution: true;
}>;

export type DesktopLocalPluginExecutionResult =
  DesktopLocalPluginExecutionIdentity &
    Readonly<{
      state: "prepared" | "restartRequired";
      runtimeStatus: "ready" | "restartRequired";
      stage: "policyCommitted" | "mappingCommitted";
    }>;

/** A bounded receipt survives the Settings tree unmount during its own restart. */
export type DesktopLocalPluginExecutionStatus = Readonly<{
  previewId: string;
  pluginId: string;
}> &
  (
    | Readonly<{ state: "pending" }>
    | Readonly<{
        state: "committed";
        result: DesktopLocalPluginExecutionResult;
      }>
    | Readonly<{
        state: "failed";
        code: "desktop_plugin_execution_setup_failed";
        policyCommitted: boolean;
      }>
  );

export interface DesktopLocalPluginExecutionSetupClient {
  readonly version: typeof DESKTOP_LOCAL_PLUGIN_EXECUTION_SETUP_VERSION;
  preview(
    request: Readonly<{ pluginId: string }>,
  ): Promise<DesktopLocalPluginExecutionPreview>;
  confirm(
    request: DesktopLocalPluginExecutionConfirmation,
  ): Promise<DesktopLocalPluginExecutionResult>;
  cancel(request: Readonly<{ previewId: string }>): Promise<void>;
  readStatus(
    request: Readonly<{ pluginId: string }>,
  ): Promise<DesktopLocalPluginExecutionStatus | null>;
  subscribeStatusChanged(listener: () => void): () => void;
  subscribeOwnerChanged(listener: () => void): () => void;
}

export type DesktopLocalPluginExecutionSetupAccess = Readonly<{
  client: DesktopLocalPluginExecutionSetupClient;
  ownerKey: string;
}>;
