/** Portable, independent Node protocol. This file has no imports and does not alter SDK execution v1. */
export const CREWON_PROJECT_ASSET_TOOLS_SERVICE = "crewon.project-asset-tools";
export const CREWON_PROJECT_ASSET_CONTEXT_SERVICE =
  "crewon.project-asset-context";
export const CREWON_PROJECT_ASSET_TOOLS_API_VERSION = "1";
export const MAX_PROJECT_ASSET_TOOL_RESPONSE_BYTES = 8192;
export const MAX_PROJECT_ASSET_TOOL_PAGE_SIZE = 4;
export const PROJECT_ASSET_TOOL_OPERATIONS = Object.freeze({
  listAssets: "asset_list",
  getAsset: "asset_read",
  listRevisions: "asset_history",
  readContent: "asset_content_read",
  saveCandidate: "asset_save",
} as const);
export type ProjectAssetToolMethod = keyof typeof PROJECT_ASSET_TOOL_OPERATIONS;
export type ProjectAssetToolKind = "character" | "scene" | "prop";
export type ProjectAssetToolContent = Readonly<{
  name: string;
  setting: string;
  visualPrompt: string;
}>;
export type ProjectAssetToolHead = Readonly<{
  projectId: string;
  assetId: string;
  kind: ProjectAssetToolKind;
  revision: number;
  latestContentRevision: number;
  selectedContentRevision: number | null;
  latestReferenceRevision: number;
  selectedReferenceRevision: number | null;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}>;
export type ProjectAssetToolRevision = Readonly<{
  projectId: string;
  assetId: string;
  kind: ProjectAssetToolKind;
  contentRevision: number;
  brief: Readonly<{ briefRevision: number; contentDigest: string }>;
  script: Readonly<{
    artifactId: string;
    episodeId: string;
    contentRevision: number;
    contentDigest: string;
  }> | null;
  createdAt: string;
  contentDigest: string;
}>;
export type ProjectAssetToolsRequests = Readonly<{
  listAssets: Readonly<{
    projectId: string;
    kind: ProjectAssetToolKind;
    afterAssetId: string | null;
    limit: number;
  }>;
  getAsset: Readonly<{ projectId: string; assetId: string }>;
  listRevisions: Readonly<{
    projectId: string;
    assetId: string;
    afterContentRevision: number;
    limit: number;
  }>;
  readContent: Readonly<{
    projectId: string;
    assetId: string;
    contentRevision: number;
    offset: number;
  }>;
  saveCandidate: Readonly<{
    projectId: string;
    assetId: string | null;
    kind: ProjectAssetToolKind;
    expectedAssetRevision: number;
    briefRevision: number;
    script: Readonly<{ artifactId: string; contentRevision: number }> | null;
    content: ProjectAssetToolContent;
  }>;
}>;
export type ProjectAssetToolsResponses = Readonly<{
  listAssets: Readonly<{
    assets: readonly ProjectAssetToolHead[];
    nextAssetId: string | null;
  }>;
  getAsset: Readonly<{
    view: Readonly<{
      asset: ProjectAssetToolHead;
      selectedRevision: ProjectAssetToolRevision | null;
      dependencyState: "unselected" | "current" | "stale";
      staleReasons: readonly (
        | "brief-changed"
        | "script-selection-changed"
        | "script-source-stale"
      )[];
      referenceState: "unselected" | "current" | "stale";
    }> | null;
  }>;
  listRevisions: Readonly<{
    revisions: readonly ProjectAssetToolRevision[];
    nextContentRevision: number | null;
  }>;
  readContent: Readonly<{
    contentDigest: string;
    format: "canonical-json";
    offset: number;
    nextOffset: number | null;
    totalCodePoints: number;
    text: string;
  }>;
  saveCandidate: Readonly<{
    kind: "save-content";
    disposition: "committed" | "replayed";
    asset: ProjectAssetToolHead;
    contentRevision: ProjectAssetToolRevision;
  }>;
}>;
/** Possession alone supplies no permission. Every method requires the original live dispatched command. */
export type PluginProjectAssetToolsService = Readonly<{
  [M in ProjectAssetToolMethod]: (
    input: Readonly<{
      command: unknown;
      request: ProjectAssetToolsRequests[M];
    }>,
  ) => Promise<ProjectAssetToolsResponses[M]>;
}>;
export type ProjectAssetRuntimeScope = Readonly<{
  version: "crewon.project-asset-runtime-scope.v1";
  runId: string;
  threadId: string;
  projectId: string;
  bindingId: string;
  bindingRevision: number;
  workspaceId: string | null;
  stage: Readonly<{
    kind: "assets";
    assetKind: ProjectAssetToolKind;
    briefRevision: number;
    script: Readonly<{
      artifactId: string;
      episodeId: string;
      contentRevision: number;
    }> | null;
  }>;
  sources: Readonly<{
    brief: Readonly<{ briefRevision: number; contentDigest: string }>;
    script: Readonly<{
      artifactId: string;
      episodeId: string;
      contentRevision: number;
      contentDigest: string;
    }> | null;
  }>;
  allowedOperations: readonly string[];
  admissionDigest: string;
}>;
export type ProjectAssetContextResponse = Readonly<{
  scope: ProjectAssetRuntimeScope | null;
}>;
export interface PluginProjectAssetContextService {
  readScope(
    input: Readonly<{ command: unknown }>,
  ): Promise<ProjectAssetContextResponse>;
}
export interface ProjectAssetToolsCodec {
  parseRequest<M extends ProjectAssetToolMethod>(
    method: M,
    input: unknown,
  ): ProjectAssetToolsRequests[M];
  parseResponse<M extends ProjectAssetToolMethod>(
    method: M,
    request: ProjectAssetToolsRequests[M],
    input: unknown,
  ): ProjectAssetToolsResponses[M];
  parseContextResponse(input: unknown): ProjectAssetContextResponse;
}
