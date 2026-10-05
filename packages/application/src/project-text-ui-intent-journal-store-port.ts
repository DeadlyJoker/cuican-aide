import type {
  ProjectTextUiIntentScope,
  ProjectTextUiIntent,
  ProjectTextUiIntentAction,
  ProjectTextUiIntentRefusalCode,
} from "@crewon/domain";
import type { CreativeProjectCommitOptions } from "./creative-project-store-port.ts";
import type { ProjectTextRecoveryCommitAuthority } from "./project-text-recovery-commit-authority.ts";

export type ProjectTextRecoveryCommitOptions = Readonly<{
  authority: ProjectTextRecoveryCommitAuthority;
}>;
/** Explicit parent-owned journal. Accepted receipt references share the original text COMMIT. */
export interface ProjectTextUiIntentJournalStore {
  migrate(): Promise<void>;
  stage(
    input: Readonly<{
      scope: ProjectTextUiIntentScope;
      actionId: ProjectTextUiIntentAction;
      input: unknown;
      intentId: string;
      at: string;
    }>,
    options: CreativeProjectCommitOptions,
  ): Promise<ProjectTextUiIntent>;
  getPending(
    input: Readonly<{ scope: ProjectTextUiIntentScope }>,
    options: ProjectTextRecoveryCommitOptions,
  ): Promise<ProjectTextUiIntent | null>;
  acknowledge(
    input: Readonly<{
      scope: ProjectTextUiIntentScope;
      intentId: string;
      expectedRevision: number;
      at: string;
    }>,
    options: ProjectTextRecoveryCommitOptions,
  ): Promise<
    Readonly<{
      intent: ProjectTextUiIntent;
      disposition: "acknowledged" | "replayed";
    }>
  >;
  /** Only a same-connection receipt/terminal fence can establish a deterministic refusal. */
  observeRejected(
    input: Readonly<{
      scope: ProjectTextUiIntentScope;
      intentId: string;
      at: string;
      code: ProjectTextUiIntentRefusalCode;
    }>,
    options: CreativeProjectCommitOptions,
  ): Promise<ProjectTextUiIntent>;
}
