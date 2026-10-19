/** Portable Node protocol. Vendoring this file requires no SDK or host source dependency.
 * Opaque commands require the real active Worker invocation; DTOs never grant execution.
 */
export const CREWON_PROJECT_MEDIA_EXECUTION_SERVICE =
  "crewon.project-media-execution";
export const CREWON_PROJECT_MEDIA_EXECUTION_API_VERSION = "1";
export type ProjectMediaExecutionWorkflowId =
  | "krea2-reference-four-view"
  | "flux2-three-reference-storyboard";
export type ProjectMediaExecutionRole =
  | "character"
  | "scene"
  | "characterOne"
  | "characterTwo";
export type ProjectMediaExecutionReference = Readonly<{
  schemaVersion: "crewon.project-media-generation-reference.v1";
  projectId: string;
  mediaInputId: string;
  inputRevision: number;
  expectedInputRevision: number;
  executionId: string;
  mediaInputDigest: string;
  workflowId: ProjectMediaExecutionWorkflowId;
  materials: readonly Readonly<{
    role: ProjectMediaExecutionRole;
    intentId: string;
    initialDigest: string;
    eventRevision: number;
    eventDigest: string;
  }>[];
}>;
export type ProjectMediaExecutionWorkflow = Readonly<{
  workflowId: ProjectMediaExecutionWorkflowId;
  workflowDigest: string;
  output: Readonly<{
    kind: "image";
    nodeId: "129" | "17";
    dimensions: "workflow-native";
  }>;
}>;
export type ProjectMediaExecutionOperation = Readonly<{
  schemaVersion: "crewon.external-operation.v0";
  tenantId: string;
  runId: string;
  bindingDigest: string;
  operationId: string;
  executionId: string;
  idempotencyKey: string;
  actionDigest: string;
  requestDigest: string;
  correlationId: string;
  providerOperationId: string | null;
  status:
    | "submitting"
    | "submitted"
    | "queued"
    | "running"
    | "unknownOutcome"
    | "succeeded"
    | "failed";
  resultJson: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;
export type ProjectMediaExecutionExisting = Readonly<{
  kind: "existing";
  reference: ProjectMediaExecutionReference;
  workflow: ProjectMediaExecutionWorkflow;
  operation: ProjectMediaExecutionOperation;
}>;
export type ProjectMediaExecutionNew = Readonly<{
  kind: "new";
  reference: ProjectMediaExecutionReference;
  workflow: ProjectMediaExecutionWorkflow;
  prompt: string;
  targetServiceOrigin: string;
  images: Readonly<
    Partial<
      Record<
        ProjectMediaExecutionRole,
        Readonly<{
          filename: string;
          subfolder: string;
          type: "output" | "input";
        }>
      >
    >
  >;
}>;
export interface PluginProjectMediaExecutionService {
  /** New submission preflight, or the existing original. May recheck current target bytes only when new. */
  readInput(
    request: Readonly<{ command: unknown }>,
  ): Promise<ProjectMediaExecutionNew | ProjectMediaExecutionExisting>;
  /** Original observation only. Null means no original reservation; never prepares materials or grants POST. */
  readOperation(
    request: Readonly<{ command: unknown }>,
  ): Promise<ProjectMediaExecutionExisting | null>;
}
