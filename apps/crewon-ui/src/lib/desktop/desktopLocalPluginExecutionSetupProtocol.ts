export const DESKTOP_SHORT_DRAMA_IMAGE_PRESETS = [
  "krea2-portrait",
  "krea2-character-three-view",
  "api-c16-scene",
  "api-c16-portrait",
  "api-t4-three-view",
] as const;
export type DesktopShortDramaImagePreset =
  (typeof DESKTOP_SHORT_DRAMA_IMAGE_PRESETS)[number];
export function isDesktopShortDramaImagePreset(
  input: unknown,
): input is DesktopShortDramaImagePreset {
  return (
    typeof input === "string" &&
    DESKTOP_SHORT_DRAMA_IMAGE_PRESETS.some((value) => value === input)
  );
}

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

/** Explicit read-only delegation to one already approved installed historical target. */
export type DesktopLocalPluginHistoricalQueryPreview = Readonly<{
  source: Readonly<{
    pluginId: string;
    packageDigest: string;
    contributionId: string;
  }>;
  target: Readonly<{
    pluginId: string;
    publisherId: string;
    version: string;
    packageDigest: string;
    manifestDigest: string;
    implementationDigest: string;
    contributionId: string;
    action: "image.query";
  }>;
  selectionRevision: number;
  configurationRevision: number;
  configurationDigest: string;
  scope: "query-existing-generations";
  methods: readonly ["GET"];
}>;

export type DesktopLocalPluginExecutionPreview =
  DesktopLocalPluginExecutionIdentity &
    Readonly<{
      previewId: string;
      expiresAt: number;
      baseUrl: string;
      preset: DesktopShortDramaImagePreset;
      networkPaths: readonly DesktopLocalPluginExecutionNetworkPath[];
      approvalRequirement: "none";
      mediaInputPreparation?: Readonly<{
        scope: "read-write-inputs";
        workflows: readonly Readonly<{
          workflowId:
            | "krea2-reference-four-view"
            | "flux2-three-reference-storyboard";
          workflowDigest: string;
        }>[];
      }>;
      mediaGenerationPreparation?: Readonly<{
        scope: "generate-from-adopted-references";
        alreadyApproved: boolean;
        workflows: NonNullable<
          DesktopLocalPluginExecutionPreview["mediaInputPreparation"]
        >["workflows"];
        additionalNetworkPaths: readonly [
          Readonly<{
            method: "POST";
            path: "/upload/image" | "/api/comfy/upload/file";
          }>,
        ];
      }>;
      historyQueryAvailability?: "available" | "unavailable";
      historyQuery?: DesktopLocalPluginHistoricalQueryPreview;
    }>;

/** Consent refers to one Main-owned preview, never renderer-supplied permissions. */
export type DesktopLocalPluginExecutionConfirmation = Readonly<{
  previewId: string;
  approveExecution: true;
  approveHistoricalQueries?: true;
  approveMediaGenerations?: true;
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
