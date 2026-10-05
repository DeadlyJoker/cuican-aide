import type {
  ProjectAsset,
  ProjectAssetRevision,
  ProjectAssetReferenceRevision,
  ProjectAssetDependencyStatus,
  ProjectAssetKind,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type {
  CreativeProjectMutationReceipt,
  CreativeProjectOwnerScope,
} from "./creative-project-store-port.ts";
import type { ProjectAssetCommitOptions } from "./project-asset-commit-authority.ts";
import type {
  ProjectAssetMutationKind,
  ProjectAssetMutationCommand,
} from "./project-asset-commands.ts";

export type ProjectAssetReadScope = Readonly<{
  owner: CreativeProjectOwnerScope;
  projectId: string;
}>;
export type ProjectAssetView = ProjectAssetDependencyStatus &
  Readonly<{
    asset: ProjectAsset;
    selectedRevision: ProjectAssetRevision | null;
    selectedReference: ProjectAssetReferenceRevision | null;
    referenceState: "unselected" | "current" | "stale";
  }>;
export type ProjectAssetMutationResult = Readonly<{
  kind: ProjectAssetMutationKind;
  disposition: "committed" | "replayed";
  asset: ProjectAsset;
  contentRevision: ProjectAssetRevision | null;
  referenceRevision: ProjectAssetReferenceRevision | null;
}>;
export type ProjectAssetMutationIdentity = Readonly<{
  actor: ActorContext;
  kind: ProjectAssetMutationKind;
  receipt: CreativeProjectMutationReceipt;
}>;
export type CommitProjectAssetMutationInput = ProjectAssetMutationIdentity &
  Readonly<{
    command: ProjectAssetMutationCommand;
    at: string;
    /** Only null-ID creation receives a host-generated ID; replay never derives a replacement. */
    createdAssetId: string | null;
  }>;

/** Independent archive; implementations re-read ownership, active project, sources and qualifiers on one connection. */
export interface ProjectAssetStore {
  loadAsset(
    input: ProjectAssetReadScope & Readonly<{ assetId: string }>,
  ): Promise<ProjectAsset | null>;
  loadRevision(
    input: ProjectAssetReadScope &
      Readonly<{ assetId: string; contentRevision: number }>,
  ): Promise<ProjectAssetRevision | null>;
  loadReferenceRevision(
    input: ProjectAssetReadScope &
      Readonly<{ assetId: string; referenceRevision: number }>,
  ): Promise<ProjectAssetReferenceRevision | null>;
  listAssets(
    input: ProjectAssetReadScope &
      Readonly<{
        kind: ProjectAssetKind | null;
        afterAssetId: string | null;
        limit: number;
      }>,
  ): Promise<
    Readonly<{ assets: readonly ProjectAsset[]; nextAssetId: string | null }>
  >;
  listRevisions(
    input: ProjectAssetReadScope &
      Readonly<{
        assetId: string;
        afterContentRevision: number;
        limit: number;
      }>,
  ): Promise<
    Readonly<{
      revisions: readonly ProjectAssetRevision[];
      nextContentRevision: number | null;
    }>
  >;
  listReferences(
    input: ProjectAssetReadScope &
      Readonly<{
        assetId: string;
        afterReferenceRevision: number;
        limit: number;
      }>,
  ): Promise<
    Readonly<{
      references: readonly ProjectAssetReferenceRevision[];
      nextReferenceRevision: number | null;
    }>
  >;
  loadMutationReceipt(
    input: ProjectAssetMutationIdentity,
    options?: ProjectAssetCommitOptions,
  ): Promise<ProjectAssetMutationResult | null>;
  commitMutation(
    input: CommitProjectAssetMutationInput,
    options?: ProjectAssetCommitOptions,
  ): Promise<ProjectAssetMutationResult>;
}
