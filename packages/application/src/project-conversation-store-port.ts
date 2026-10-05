import type {
  ProjectConversationBinding,
  ProjectConversationInstallation,
  ProjectStageRunAdmission,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type {
  PluginSelection,
  InstalledPluginPackage,
  PluginTaskAdmissionPin,
} from "@crewon/domain";
import type { CommitThreadInput } from "./thread-store-port.ts";
/** Actual trusted Control owner; public bodies cannot provide any field here. */
export type ProjectConversationCommitAuthority = Readonly<{
  version: "crewon.project-conversation-commit.v1";
  actor: ActorContext;
  installation: ProjectConversationInstallation;
  selection: PluginSelection;
  package: InstalledPluginPackage;
  pin: PluginTaskAdmissionPin;
  assertCurrent(): Promise<void>;
  assertTransactionCurrent(): Promise<void>;
  assertActive(): void;
}>;
export type ProjectConversationReceipt = Readonly<{
  actor: ActorContext;
  idempotencyKey: string;
  requestDigest: string;
}>;
export type ProjectConversationMutation = Readonly<{
  kind: "create" | "refresh-source" | "set-state";
  disposition: "committed" | "replayed";
  binding: ProjectConversationBinding;
}>;
export type ProjectConversationOwner = Readonly<{
  actor: ActorContext;
  profileId: string;
}>;
export interface ProjectConversationStore {
  readonly version: "crewon.project-conversation-binding.v1";
  migrate(): Promise<void>;
  /** Trusted routing guard, independent of caller ownership; never projected publicly. */
  hasThreadBinding(
    input: Readonly<{ tenantId: string; spaceId: string; threadId: string }>,
  ): Promise<boolean>;
  loadBinding(
    input: ProjectConversationOwner & Readonly<{ threadId: string }>,
  ): Promise<ProjectConversationBinding | null>;
  listBindings(
    input: ProjectConversationOwner &
      Readonly<{
        projectId: string;
        afterThreadId: string | null;
        limit: number;
      }>,
  ): Promise<
    Readonly<{
      bindings: readonly ProjectConversationBinding[];
      nextThreadId: string | null;
    }>
  >;
  loadMutationReceipt(
    input: ProjectConversationOwner &
      Readonly<{ receipt: ProjectConversationReceipt }>,
  ): Promise<ProjectConversationMutation | null>;
  commitBinding(
    input: Readonly<{
      kind: ProjectConversationMutation["kind"];
      binding: ProjectConversationBinding;
      expectedRevision: number;
      receipt: ProjectConversationReceipt;
      thread?: CommitThreadInput;
      /** Creation against an existing idle Thread; the writer checks this inside its transaction. */
      existingThread?: Readonly<{ expectedRevision: number }>;
    }>,
    options: Readonly<{ authority: ProjectConversationCommitAuthority }>,
  ): Promise<ProjectConversationMutation>;
  /** Independent marker persisted beside the original immutable task admission. */
  readRequiredStageDigest(
    input: Readonly<{ tenantId: string; spaceId: string; runId: string }>,
  ): Promise<string | null>;
  loadStageAdmission(
    input: Readonly<{ tenantId: string; spaceId: string; runId: string }>,
  ): Promise<ProjectStageRunAdmission | null>;
}
