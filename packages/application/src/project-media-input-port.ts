import type { ActorContext } from "./authorization-port.ts";
import type {
  ProjectAssetReferenceImageQuery,
  ProjectAssetReferenceImageSource,
} from "./project-asset-reference-image-store-port.ts";
import type {
  ProjectMaterialPreparationRequest,
  ProjectMaterialPreparationTarget,
} from "./project-material-preparation-port.ts";

export type ProjectMediaWorkflowId =
  | "krea2-reference-four-view"
  | "flux2-three-reference-storyboard";
export type ProjectMediaRole =
  | "character"
  | "scene"
  | "characterOne"
  | "characterTwo";
export type ProjectMediaItem =
  | Readonly<{ kind: "character-reference"; assetId: string }>
  | Readonly<{ kind: "storyboard-frame-exploration"; episodeId: string }>;
export type ProjectMediaWorkflow = Readonly<{
  workflowId: ProjectMediaWorkflowId;
  workflowDigest: string;
  output: Readonly<{
    kind: "image";
    nodeId: "129" | "17";
    dimensions: "workflow-native";
  }>;
}>;
/** Host deployment review only, never a UI/Agent field or execution grant. */
export type ProjectMediaWorkflowReview = Readonly<{
  targetIdentity: Readonly<{
    pluginId: "crewon.short-drama";
    version: string;
    publisherId: string;
    packageDigest: string;
    manifestDigest: string;
    implementationDigest: string;
  }>;
  workflow: ProjectMediaWorkflow;
}>;
export type SaveProjectMediaInputCommand = Readonly<{
  projectId: string;
  mediaInputId: string | null;
  expectedInputRevision: number;
  item: ProjectMediaItem;
  briefRevision: number;
  script: Readonly<{ artifactId: string; contentRevision: number }> | null;
  workflowId: ProjectMediaWorkflowId;
  prompt: string;
  references: Readonly<
    Partial<Record<ProjectMediaRole, ProjectAssetReferenceImageQuery>>
  >;
  target: ProjectMaterialPreparationRequest["target"];
  idempotencyKey: string;
}>;
export type ProjectMediaReference = Readonly<{
  role: ProjectMediaRole;
  sourceDigest: string;
  contentDigest: string;
  referenceDigest: string;
  resultLinkDigest: string;
  sourceBindingDigest: string;
  sourceRunId: string;
  operationId: string;
  resultIndex: number;
  sourceConfigurationDigest: string;
  preparation: ProjectMaterialPreparationRequest;
}>;
/** Confirmed logical input. Preparation keys are associations, not upload receipts or media readiness. */
export type ProjectMediaInputRevision = Readonly<{
  schemaVersion: "crewon.project-media-input.v1";
  actor: ActorContext;
  projectId: string;
  mediaInputId: string;
  inputRevision: number;
  item: ProjectMediaItem;
  brief: Readonly<{ briefRevision: number; contentDigest: string }>;
  script: Readonly<{
    artifactId: string;
    contentRevision: number;
    contentDigest: string;
  }> | null;
  workflow: ProjectMediaWorkflow;
  prompt: string;
  references: readonly ProjectMediaReference[];
  target: ProjectMaterialPreparationTarget;
  createdAt: string;
  contentDigest: string;
}>;
export type ProjectMediaInputQuery = Readonly<{
  actor: ActorContext;
  projectId: string;
  mediaInputId: string;
  inputRevision: number | null;
}>;
export type ProjectMediaInputState = Readonly<{
  input: ProjectMediaInputRevision;
  latestInputRevision: number;
}>;
/** Bounded discovery of original input identities; no prompts or supplier paths. */
export type ProjectMediaInputListQuery = Readonly<{
  actor: ActorContext;
  projectId: string;
  afterMediaInputId: string | null;
  limit: number;
}>;
export type ProjectMediaInputSummary = Readonly<{
  projectId: string;
  mediaInputId: string;
  latestInputRevision: number;
  item: ProjectMediaItem;
  workflowId: ProjectMediaWorkflowId;
  createdAt: string;
}>;
export type ProjectMediaInputPage = Readonly<{
  inputs: readonly ProjectMediaInputSummary[];
  nextMediaInputId: string | null;
}>;
export type ProjectMediaInputWrite = Readonly<{
  actor: ActorContext;
  command: SaveProjectMediaInputCommand;
  createdMediaInputId: string | null;
  sources: readonly Readonly<{
    role: ProjectMediaRole;
    source: ProjectAssetReferenceImageSource;
  }>[];
  target: ProjectMaterialPreparationTarget;
  workflow: ProjectMediaWorkflow;
  at: string;
}>;
export type ProjectMediaInputAuthority = Readonly<{
  version: "crewon.project-media-input-commit.v1";
  actor: ActorContext;
  projectId: string;
  action: "read" | "write" | "qualify";
  review: ProjectMediaWorkflowReview | null;
  assertCurrent(): Promise<void>;
  assertTransactionCurrent(): Promise<void>;
  assertActive(): void;
}>;
export interface ProjectMediaInputStore {
  list(
    query: ProjectMediaInputListQuery,
    authority: ProjectMediaInputAuthority,
  ): Promise<ProjectMediaInputPage>;
  load(
    query: ProjectMediaInputQuery,
    authority: ProjectMediaInputAuthority,
  ): Promise<ProjectMediaInputState | null>;
  loadReceipt(
    input: Readonly<{
      actor: ActorContext;
      command: SaveProjectMediaInputCommand;
    }>,
    authority: ProjectMediaInputAuthority,
  ): Promise<ProjectMediaInputRevision | null>;
  save(
    input: ProjectMediaInputWrite,
    authority: ProjectMediaInputAuthority,
  ): Promise<
    Readonly<{
      disposition: "committed" | "replayed";
      input: ProjectMediaInputRevision;
    }>
  >;
  /** Dedicated metadata qualification, not Run admission. This method owns its transaction;
   * future Run integration must compose the SQL qualification plan on the Run's own connection.
   */
  qualify(
    input: ProjectMediaInputQuery & Readonly<{ expectedInputRevision: number }>,
    authority: ProjectMediaInputAuthority,
  ): Promise<ProjectMediaInputRevision>;
}
