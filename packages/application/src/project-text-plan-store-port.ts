import type {
  ProjectTextPlan,
  ProjectTextPlanRevision,
  ProjectTextPlanStep,
  ProjectTextPlanRunAdmission,
  ProjectTextPlanDelegation,
  ProjectTextPlanResultReference,
  ProjectTextPlanSelectionReference,
  PluginSelection,
  InstalledPluginPackage,
  ProjectConversationBinding,
  ProjectStageRunAdmission,
  ExtensionRunBinding,
  RunState,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { ProjectConversationCommitAuthority } from "./project-conversation-store-port.ts";

export type ProjectTextPlanOwner = Readonly<{
  actor: ActorContext;
  profileId: string;
}>;
export type ProjectTextPlanReceipt = Readonly<{
  actor: ActorContext;
  idempotencyKey: string;
  requestDigest: string;
}>;
export type ProjectTextPlanMutation = Readonly<{
  kind:
    | "start"
    | "pause"
    | "revoke"
    | "resume"
    | "reviseRemaining"
    | "continue";
  disposition: "committed" | "replayed";
  plan: ProjectTextPlan;
  planRevision: ProjectTextPlanRevision;
  steps: readonly ProjectTextPlanStep[];
}>;
/** Actual current host owner. Stored delegation is revalidated, never used as a bearer token. */
export type ProjectTextPlanCommitAuthority = Readonly<{
  version: "crewon.project-text-plan-commit.v1";
  actor: ActorContext;
  binding: ProjectConversationBinding;
  selection: PluginSelection;
  package: InstalledPluginPackage;
  /** Only explicit start/resume/reviseRemaining may supply a newly captured UI delegation. */
  delegation: ProjectTextPlanDelegation | null;
  backgroundAuthorization: "available" | "unavailable";
  assertCurrent(): Promise<void>;
  /** External identity/profile/PDP/delegation fence only: no reborrowing the committing pool. */
  assertTransactionCurrent(): Promise<void>;
  assertActive(): void;
}>;
export type ProjectTextPlanTurnCommitAuthority = Readonly<{
  version: "crewon.project-text-plan-turn-commit.v1";
  plan: ProjectTextPlan;
  planRevision: ProjectTextPlanRevision;
  step: ProjectTextPlanStep;
  authority: ProjectTextPlanCommitAuthority;
}>;
/** Distinct selection protocol: neither a UI invocation nor a terminal Run/tool grant. */
export type ProjectTextPlanSelectionCommitAuthority = Readonly<{
  version: "crewon.project-text-plan-selection-commit.v1";
  plan: ProjectTextPlan;
  planRevision: ProjectTextPlanRevision;
  step: ProjectTextPlanStep;
  admission: ProjectTextPlanRunAdmission;
  result: ProjectTextPlanResultReference;
  /** Exact original select command, checked against the genuine business receipt. */
  input: Readonly<{
    projectId: string;
    artifactId: string;
    contentRevision: number;
    expectedArtifactRevision: number;
    idempotencyKey: string;
  }>;
  authority: ProjectTextPlanCommitAuthority;
  assertCurrent(): Promise<void>;
}>;
export type ProjectTextPlanLocator = ProjectTextPlanOwner &
  Readonly<{ planId: string }>;
export interface ProjectTextPlanStore {
  readonly version: "crewon.project-text-plan.v1";
  migrate(): Promise<void>;
  loadPlan(input: ProjectTextPlanLocator): Promise<ProjectTextPlan | null>;
  loadRevision(
    input: ProjectTextPlanLocator & Readonly<{ planRevision: number }>,
  ): Promise<ProjectTextPlanRevision | null>;
  loadStep(
    input: ProjectTextPlanLocator & Readonly<{ stepId: string }>,
  ): Promise<ProjectTextPlanStep | null>;
  listSteps(
    input: ProjectTextPlanLocator & Readonly<{ planRevision: number }>,
  ): Promise<readonly ProjectTextPlanStep[]>;
  listPlans(
    input: ProjectTextPlanOwner &
      Readonly<{
        projectId: string;
        afterPlanId: string | null;
        limit: number;
      }>,
  ): Promise<
    Readonly<{ plans: readonly ProjectTextPlan[]; nextPlanId: string | null }>
  >;
  loadMutationReceipt(
    input: ProjectTextPlanOwner & Readonly<{ receipt: ProjectTextPlanReceipt }>,
  ): Promise<ProjectTextPlanMutation | null>;
  /** Rebuild/verify the actual control transition on this connection. Cannot insert a Run/result. */
  commitControl(
    input: Readonly<{
      kind: ProjectTextPlanMutation["kind"];
      plan: ProjectTextPlan;
      expectedRevision: number;
      planRevision: ProjectTextPlanRevision;
      steps: readonly ProjectTextPlanStep[];
      receipt: ProjectTextPlanReceipt;
    }>,
    options: Readonly<{ authority: ProjectTextPlanCommitAuthority }>,
  ): Promise<ProjectTextPlanMutation>;
  /** Strictly re-read the actual terminal Run/event and exact saved result before checkpointing. */
  commitObservation(
    input: Readonly<{
      owner: ProjectTextPlanOwner;
      planId: string;
      expectedRevision: number;
      stepId: string;
      expectedStepRevision: number;
      run: RunState;
      terminal: NonNullable<ProjectTextPlanStep["terminal"]>;
      at: string;
    }>,
    options: Readonly<{ authority: ProjectTextPlanCommitAuthority }>,
  ): Promise<Readonly<{ plan: ProjectTextPlan; step: ProjectTextPlanStep }>>;
  /** Current metadata owner records a pause fact only; this cannot create execution or selection. */
  commitSystemPause(
    input: Readonly<{
      owner: ProjectTextPlanOwner;
      planId: string;
      expectedRevision: number;
      stepId: string;
      expectedStepRevision: number;
      reason: Exclude<
        NonNullable<ProjectTextPlan["pauseReason"]>,
        "user_paused"
      >;
      at: string;
    }>,
    options: Readonly<{ authority: ProjectTextPlanCommitAuthority }>,
  ): Promise<Readonly<{ plan: ProjectTextPlan; step: ProjectTextPlanStep }>>;
  /** Bounded durable readiness/terminal discovery; no fabricated execution WorkItem. */
  scanRecoverable(
    input: Readonly<{
      tenantId: string;
      spaceId: string;
      profileId: string;
      afterPlanId: string | null;
      limit: number;
    }>,
  ): Promise<
    Readonly<{
      locators: readonly ProjectTextPlanLocator[];
      nextPlanId: string | null;
    }>
  >;
  readRequiredPlanDigest(
    input: Readonly<{ tenantId: string; spaceId: string; runId: string }>,
  ): Promise<string | null>;
  loadRunAdmission(
    input: Readonly<{ tenantId: string; spaceId: string; runId: string }>,
  ): Promise<ProjectTextPlanRunAdmission | null>;
}
/** Same-connection hooks receive actual original records, never pre-committed plan claims. */
export type ProjectTextPlanOriginalTurnEvidence = Readonly<{
  admission: ProjectTextPlanRunAdmission;
  stageAdmission: ProjectStageRunAdmission;
  binding: ExtensionRunBinding;
  authority: ProjectTextPlanTurnCommitAuthority;
  conversationAuthority: ProjectConversationCommitAuthority;
}>;
export type ProjectTextPlanSelectionCheckpoint = Readonly<{
  selection: ProjectTextPlanSelectionReference;
  plan: ProjectTextPlan;
  step: ProjectTextPlanStep;
}>;
