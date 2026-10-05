import type { CreativeProjectActor } from "./creative-project.ts";
import type { ProjectConversationInstallation } from "./project-conversation-binding.ts";
import type { ProjectStageSources } from "./project-stage-run-admission.ts";
import type { ExtensionExecutionTarget } from "./extension-configuration.ts";

export type ProjectTextPlanStage = "brief" | "outline" | "script";
export type ProjectTextPlanAdoption = "manual" | "whenUnchanged";
export type ProjectTextPlanState =
  | "ready"
  | "running"
  | "waitingSelection"
  | "paused"
  | "completed"
  | "revoked";
export type ProjectTextPlanPauseReason =
  | "source_changed"
  | "selection_changed"
  | "locked"
  | "binding_changed"
  | "installation_changed"
  | "authorization_unavailable"
  | "run_failed"
  | "run_canceled"
  | "result_missing"
  | "result_invalid"
  | "user_paused";
export type ProjectTextPlan = Readonly<{
  schemaVersion: "crewon.project-text-plan.v1";
  planId: string;
  owner: CreativeProjectActor;
  profileId: string;
  projectId: string;
  threadId: string;
  bindingId: string;
  workspaceId: string | null;
  revision: number;
  currentPlanRevision: number;
  state: ProjectTextPlanState;
  activeStepId: string | null;
  pauseReason: ProjectTextPlanPauseReason | null;
  /** Durable readiness generation; updated with the checkpoint, never by a UI timer. */
  wakeRevision: number;
  createdAt: string;
  updatedAt: string;
  contentDigest: string;
}>;
export type ProjectTextPlanHeadBaseline = Readonly<{
  kind: "outline" | "script";
  episodeId: string | null;
  artifactId: string | null;
  artifactRevision: number;
  selectedContentRevision: number | null;
  locked: boolean;
}>;
/** Captured only by an actual host UI invocation; persisted provenance is not a grant. */
export type ProjectTextPlanDelegation = Readonly<{
  kind: "pluginUi";
  contributionId: string;
  actionId:
    | "crewon.project-text-plans.v1.start"
    | "crewon.project-text-plans.v1.reviseRemaining"
    | "crewon.project-text-plans.v1.resume";
  invocationId: string;
  idempotencyKey: string;
  inputDigest: string;
}>;
export type ProjectTextPlanRevision = Readonly<{
  schemaVersion: "crewon.project-text-plan-revision.v1";
  planId: string;
  planRevision: number;
  actor: CreativeProjectActor;
  installation: ProjectConversationInstallation;
  projectId: string;
  threadId: string;
  bindingId: string;
  bindingRevision: number;
  workspaceId: string | null;
  configurationRevision: number;
  configurationDigest: string;
  target: ExtensionExecutionTarget;
  start: ProjectTextPlanStage;
  targetStage: ProjectTextPlanStage;
  episodeMode: "none" | "newOutline" | "selectedOutline" | "independentScripts";
  /** Server-frozen IDs for a new outline, or verified IDs from the exact selected outline. */
  episodeIds: readonly string[];
  adoption: ProjectTextPlanAdoption;
  concurrency: 1;
  maximumResultsPerStep: 1;
  instruction: string;
  instructionDigest: string;
  delegation: ProjectTextPlanDelegation;
  sources: ProjectStageSources;
  baselines: readonly ProjectTextPlanHeadBaseline[];
  createdAt: string;
  contentDigest: string;
}>;
export type ProjectTextPlanResultReference = Readonly<{
  kind: "brief" | "outline" | "script";
  /** The actual original business mutation receipt, not assistant text. */
  idempotencyKey: string;
  requestDigest: string;
  runId: string;
  toolReceiptId: string;
  toolInputDigest: string;
  briefRevision: number | null;
  artifactId: string | null;
  artifactRevision: number | null;
  contentRevision: number | null;
  contentDigest: string;
}>;
export type ProjectTextPlanSelectionReference = Readonly<{
  mode: ProjectTextPlanAdoption;
  idempotencyKey: string;
  requestDigest: string;
  artifactId: string;
  artifactRevision: number;
  contentRevision: number;
  contentDigest: string;
}>;
export type ProjectTextPlanStep = Readonly<{
  schemaVersion: "crewon.project-text-plan-step.v1";
  planId: string;
  planRevision: number;
  stepId: string;
  ordinal: number;
  kind: ProjectTextPlanStage;
  episodeId: string | null;
  attempt: number;
  revision: number;
  state:
    | "ready"
    | "admitted"
    | "waitingSelection"
    | "succeeded"
    | "paused"
    | "failed"
    | "revoked";
  sources: ProjectStageSources | null;
  baseline: ProjectTextPlanHeadBaseline | null;
  input: Readonly<{
    content: string;
    idempotencyKey: string;
    expectedThreadRevision: number;
  }> | null;
  run: Readonly<{
    runId: string;
    stageAdmissionDigest: string;
    planAdmissionDigest: string;
  }> | null;
  result: ProjectTextPlanResultReference | null;
  selection: ProjectTextPlanSelectionReference | null;
  terminal: Readonly<{
    eventId: string;
    throughSequence: number;
    runRevision: number;
    status: "completed" | "failed" | "canceled";
  }> | null;
  createdAt: string;
  updatedAt: string;
  contentDigest: string;
}>;
/** Independent immutable evidence; the existing stage admission v1 stays unchanged. */
export type ProjectTextPlanRunAdmission = Readonly<{
  schemaVersion: "crewon.project-text-plan-run-admission.v1";
  planId: string;
  planRevision: number;
  planRevisionDigest: string;
  stepId: string;
  stepRevision: number;
  attempt: number;
  actor: CreativeProjectActor;
  installation: ProjectConversationInstallation;
  projectId: string;
  threadId: string;
  bindingId: string;
  bindingRevision: number;
  workspaceId: string | null;
  configurationRevision: number;
  configurationDigest: string;
  runId: string;
  stageAdmissionDigest: string;
  extensionBindingDigest: string;
  delegationDigest: string;
  inputDigest: string;
  idempotencyKey: string;
  /** Original TaskCore command key, distinct from the derived task receipt key. */
  taskIdempotencyKey: string;
  kind: ProjectTextPlanStage;
  episodeId: string | null;
  expectedEpisodeIds: readonly string[];
  sources: ProjectStageSources;
  baseline: ProjectTextPlanHeadBaseline | null;
  createdAt: string;
  contentDigest: string;
}>;
