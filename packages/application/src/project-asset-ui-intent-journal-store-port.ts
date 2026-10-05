import type {
  ProjectAssetUiIntentScope,
  ProjectAssetUiIntent,
  ProjectAssetUiIntentAction,
  ProjectAssetUiIntentRefusalCode,
} from "@crewon/domain";
import type { ProjectAssetCommitOptions } from "./project-asset-commit-authority.ts";
import type { ProjectAssetRecoveryCommitAuthority } from "./project-asset-recovery-commit-authority.ts";

export type ProjectAssetRecoveryCommitOptions = Readonly<{
  authority: ProjectAssetRecoveryCommitAuthority;
}>;
/** A parent-owned, cross-project UI slot. Receipt acceptance shares the original asset COMMIT. */
export interface ProjectAssetUiIntentJournalStore {
  migrate(): Promise<void>;
  stage(
    input: Readonly<{
      scope: ProjectAssetUiIntentScope;
      actionId: ProjectAssetUiIntentAction;
      input: unknown;
      intentId: string;
      at: string;
    }>,
    options: ProjectAssetCommitOptions,
  ): Promise<ProjectAssetUiIntent>;
  getPending(
    input: Readonly<{ scope: ProjectAssetUiIntentScope }>,
    options: ProjectAssetRecoveryCommitOptions,
  ): Promise<ProjectAssetUiIntent | null>;
  /** Private scoped read includes terminal tombstones so ACK replay can recheck the original project's PDP. */
  loadIntent(
    input: Readonly<{ scope: ProjectAssetUiIntentScope; intentId: string }>,
    options: ProjectAssetRecoveryCommitOptions,
  ): Promise<ProjectAssetUiIntent | null>;
  acknowledge(
    input: Readonly<{
      scope: ProjectAssetUiIntentScope;
      intentId: string;
      expectedRevision: number;
      at: string;
    }>,
    options: ProjectAssetRecoveryCommitOptions,
  ): Promise<
    Readonly<{
      intent: ProjectAssetUiIntent;
      disposition: "acknowledged" | "replayed";
    }>
  >;
  /** Serializes with original writes and proves a specific no-COMMIT fact before marking refused. */
  observeRejected(
    input: Readonly<{
      scope: ProjectAssetUiIntentScope;
      intentId: string;
      at: string;
      code: ProjectAssetUiIntentRefusalCode;
    }>,
    options: ProjectAssetCommitOptions,
  ): Promise<ProjectAssetUiIntent>;
}
