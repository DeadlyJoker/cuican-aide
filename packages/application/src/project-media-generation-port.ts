import type { ActorContext } from "./authorization-port.ts";
import type { AuthorizationDecision } from "./authorization-port.ts";
import type { ProjectGenerationImageResultVerifier } from "./project-generation-image-result-verifier.ts";
import type {
  ExtensionRunBinding,
  PluginTaskAdmission,
  WorkflowSchemaValue,
} from "@crewon/domain";
import type { ExtensionMutationReceipt } from "./extension-store-port.ts";
import type {
  ProjectMediaRole,
  ProjectMediaWorkflowId,
  ProjectMediaInputAuthority,
  ProjectMediaInputRevision,
} from "./project-media-input-port.ts";
import type { ProjectMaterialPreparationState } from "./project-material-preparation-port.ts";

/** Original preparation event identities. Historical verification is not a current byte-read grant. */
export type ProjectMediaGenerationReference = Readonly<{
  schemaVersion: "crewon.project-media-generation-reference.v1";
  projectId: string;
  mediaInputId: string;
  inputRevision: number;
  expectedInputRevision: number;
  executionId: string;
  mediaInputDigest: string;
  workflowId: ProjectMediaWorkflowId;
  materials: readonly Readonly<{
    role: ProjectMediaRole;
    intentId: string;
    initialDigest: string;
    eventRevision: number;
    eventDigest: string;
  }>[];
}>;
export type ProjectMediaGenerationLink = Readonly<{
  schemaVersion: "crewon.project-media-generation-link.v1";
  actor: ActorContext;
  reference: ProjectMediaGenerationReference;
  binding: ExtensionRunBinding;
  admission: PluginTaskAdmission;
  receipt: ExtensionMutationReceipt;
  contentDigest: string;
}>;
/** Private coherent accepted history. Never a supplier dispatch or current-byte grant. */
export type ProjectMediaGenerationContext = Readonly<{
  link: ProjectMediaGenerationLink;
  input: ProjectMediaInputRevision;
  materials: readonly Readonly<{
    role: ProjectMediaRole;
    preparation: ProjectMaterialPreparationState;
  }>[];
}>;
/** Dedicated generation purpose. Transaction callbacks are PDP/activity only, never file/HTTP/pool reads. */
export type ProjectMediaGenerationCommitAuthority = Readonly<{
  version: "crewon.project-media-generation-commit.v1";
  actor: ActorContext;
  reference: ProjectMediaGenerationReference;
  metadata: ProjectMediaInputAuthority;
  verifier: ProjectGenerationImageResultVerifier;
  assertCurrent(): Promise<void>;
  assertTransactionCurrent(): Promise<void>;
  assertActive(): void;
}>;
/** Host-only use of an independently qualified real material service, never a client JSON field. */
export type ProjectMediaGenerationTask = Readonly<{
  reference: ProjectMediaGenerationReference;
  authority: ProjectMediaGenerationCommitAuthority;
  preflight: Readonly<{
    assertNewInput(input: WorkflowSchemaValue): Promise<void>;
    assertDispatchCurrent(): Promise<void>;
  }>;
}>;

/** Independent generation purpose. Callbacks only inspect policy/activity, including inside a Turn. */
export type ProjectMediaGenerationPermission = Readonly<{
  actor: ActorContext;
  action: "projectMedia:generate";
  resource: Readonly<{
    projectId: string;
    mediaInputId: string;
    inputRevision: number;
    expectedInputRevision: number;
    executionId: string;
  }>;
}>;
export interface ProjectMediaGenerationAuthorizationPort {
  authorize(
    input: ProjectMediaGenerationPermission,
  ): Promise<AuthorizationDecision>;
  assertActive(input: ProjectMediaGenerationPermission): void;
}
