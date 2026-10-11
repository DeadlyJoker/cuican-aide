import type { ProjectTextUiCommitTransactionAuthority } from "./project-text-ui-commit-authority.ts";
import type { ProjectOutlineUiCommitTransactionAuthority } from "./project-outline-ui-commit-authority.ts";
import type { ProjectOutlineRunCommitTransactionAuthority } from "./project-outline-run-commit-authority.ts";
import type { ProjectTextPlanSelectionCommitAuthority } from "./project-text-plan-store-port.ts";
import type { PluginProjectCreationScope } from "./plugin-project-creation-scope.ts";
import type {
  CreativeProject,
  ProjectBriefRevision,
  ConceptAsset,
  ConceptAssetRevision,
  PluginTaskAdmissionPin,
  PluginSelection,
  InstalledPluginPackage,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { CreativeProjectRunCommitTransactionAuthority } from "./creative-project-run-commit-authority.ts";

/** Every read is scoped to the actual principal, including receipt and historical reads. */
export type CreativeProjectOwnerScope = Readonly<{
  tenantId: string;
  spaceId: string;
  principalId: string;
}>;

export type CreativeProjectListCursor = Readonly<{
  updatedAt: string;
  projectId: string;
}>;

export type CreativeProjectMutationReceipt = Readonly<{
  idempotencyKey: string;
  requestDigest: string;
}>;

export type CreativeProjectMutationKind =
  | "create-project"
  | "rename-project"
  | "set-project-state"
  | "append-brief"
  | "create-concept"
  | "append-concept";

type MutationResult<Kind extends CreativeProjectMutationKind> = Readonly<{
  kind: Kind;
  disposition: "committed" | "replayed";
  project: CreativeProject;
}>;

export type CreateCreativeProjectResult = MutationResult<"create-project"> &
  Readonly<{ brief: ProjectBriefRevision }>;
export type ChangeCreativeProjectMetadataResult = MutationResult<
  "rename-project" | "set-project-state"
>;
export type AppendProjectBriefResult = MutationResult<"append-brief"> &
  Readonly<{ brief: ProjectBriefRevision }>;
export type ChangeConceptAssetResult = MutationResult<
  "create-concept" | "append-concept"
> &
  Readonly<{ asset: ConceptAsset; assetRevision: ConceptAssetRevision }>;
export type CreativeProjectMutationResult =
  | CreateCreativeProjectResult
  | ChangeCreativeProjectMetadataResult
  | AppendProjectBriefResult
  | ChangeConceptAssetResult;

type MutationIdentity = Readonly<{
  actor: ActorContext;
  receipt: CreativeProjectMutationReceipt;
}>;

/** Borrowed host authority for this exact invocation, never part of a persisted recipe. */
export type CreativeProjectPluginCommitTransactionAuthority = Readonly<{
  version: "crewon.creative-project-plugin-commit.v1";
  /** Actual registered source invocation; the Store verifies installation rows on its borrowed connection. */
  pin: PluginTaskAdmissionPin;
  selection: PluginSelection;
  package: InstalledPluginPackage;
  /** External identity/profile/policy and local owner checks only; never borrows the installation pool. */
  assertCurrent(): Promise<void>;
}>;

export type CreativeProjectCommitAuthority = Readonly<{
  assertCurrent(): Promise<void>;
  /** Synchronous local withdrawal check; returning a Promise does not establish commit authority. */
  assertActive(): void;
  transaction?: CreativeProjectPluginCommitTransactionAuthority;
  /** Distinct actual Run/Tool qualification; mutually exclusive with the legacy UI transaction. */
  runTransaction?: CreativeProjectRunCommitTransactionAuthority;
  /** Text-only manual UI qualification; mutually exclusive with both other protocols. */
  textUiTransaction?: ProjectTextUiCommitTransactionAuthority;
  /** Independently delegated exact-result selection; mutually exclusive with all other protocols. */
  planTransaction?: ProjectTextPlanSelectionCommitAuthority;
  /** Explicit structured-outline UI protocol; v1 text authority never qualifies it. */
  outlineUiTransaction?: ProjectOutlineUiCommitTransactionAuthority;
  outlineRunTransaction?: ProjectOutlineRunCommitTransactionAuthority;
}>;

export type CreativeProjectCommitOptions = Readonly<{
  authority?: CreativeProjectCommitAuthority;
  /** Separate qualified creation path; ordinary Store methods must reject this option. */
  creationScope?: PluginProjectCreationScope;
}>;

export type OwnedCreativeProjectCreationInput = MutationIdentity &
  Readonly<{
    creationScope: PluginProjectCreationScope;
    project: CreativeProject;
    initialBrief: ProjectBriefRevision;
  }>;
export type OwnedCreativeProjectCreationReceiptInput = MutationIdentity &
  Readonly<{
    creationScope: PluginProjectCreationScope;
  }>;

/**
 * Trusted internal persistence recipes, not a public owner or write-authority API.
 * Implementations must check the stored principal and tenant/space, compare revisions,
 * and commit all changed records and the actor-scoped receipt in one transaction.
 * A concept's supplied brief must be re-read from immutable storage in that transaction.
 * No recipe here starts a Run or calls a supplier. Future generation links must join
 * the original Turn/Run/credit transaction, rather than be attached after dispatch.
 * Optional per-call authority also gates replay publication and must be rechecked
 * before COMMIT dispatch. Confirmed commits are not rejected by later withdrawal.
 */
export interface OwnedCreativeProjectCreationStore {
  loadOwnedCreationReceipt(
    input: OwnedCreativeProjectCreationReceiptInput,
    options?: CreativeProjectCommitOptions,
  ): Promise<CreateCreativeProjectResult | null>;
  commitOwnedProjectCreation(
    input: OwnedCreativeProjectCreationInput,
    options?: CreativeProjectCommitOptions,
  ): Promise<CreateCreativeProjectResult>;
}

export interface CreativeProjectStore {
  loadProject(input: {
    owner: CreativeProjectOwnerScope;
    projectId: string;
  }): Promise<CreativeProject | null>;
  listProjects(input: {
    owner: CreativeProjectOwnerScope;
    state: "active" | "archived" | "all";
    after: CreativeProjectListCursor | null;
    limit: number;
  }): Promise<
    Readonly<{
      /** updatedAt descending, then projectId descending in Unicode scalar (UTF-8 binary) order. */
      projects: readonly CreativeProject[];
      /** The last returned row when another page exists; null when exhausted. */
      next: CreativeProjectListCursor | null;
    }>
  >;
  loadBrief(input: {
    owner: CreativeProjectOwnerScope;
    projectId: string;
    briefRevision: number;
  }): Promise<ProjectBriefRevision | null>;
  listBriefs(input: {
    owner: CreativeProjectOwnerScope;
    projectId: string;
    afterBriefRevision: number;
    limit: number;
  }): Promise<readonly ProjectBriefRevision[]>; // Ascending briefRevision, strictly after the cursor.
  loadConceptAsset(input: {
    owner: CreativeProjectOwnerScope;
    projectId: string;
    assetId: string;
  }): Promise<ConceptAsset | null>;
  listConceptAssets(input: {
    owner: CreativeProjectOwnerScope;
    projectId: string;
    afterAssetId: string | null;
    limit: number;
  }): Promise<readonly ConceptAsset[]>; // Ascending assetId in Unicode scalar order.
  loadConceptRevision(input: {
    owner: CreativeProjectOwnerScope;
    projectId: string;
    assetId: string;
    assetRevision: number;
  }): Promise<ConceptAssetRevision | null>;
  listConceptRevisions(input: {
    owner: CreativeProjectOwnerScope;
    projectId: string;
    assetId: string;
    afterAssetRevision: number;
    limit: number;
  }): Promise<readonly ConceptAssetRevision[]>; // Ascending assetRevision, strictly after the cursor.
  loadMutationReceipt(
    input: MutationIdentity & Readonly<{ kind: CreativeProjectMutationKind }>,
    options?: CreativeProjectCommitOptions,
  ): Promise<CreativeProjectMutationResult | null>;
  commitProjectCreation(
    input: MutationIdentity &
      Readonly<{
        project: CreativeProject;
        initialBrief: ProjectBriefRevision;
      }>,
    options?: CreativeProjectCommitOptions,
  ): Promise<CreateCreativeProjectResult>;
  commitProjectMetadata(
    input: MutationIdentity &
      Readonly<{
        kind: "rename-project" | "set-project-state";
        expectedProjectRevision: number;
        project: CreativeProject;
      }>,
    options?: CreativeProjectCommitOptions,
  ): Promise<ChangeCreativeProjectMetadataResult>;
  commitProjectBrief(
    input: MutationIdentity &
      Readonly<{
        expectedProjectRevision: number;
        project: CreativeProject;
        brief: ProjectBriefRevision;
      }>,
    options?: CreativeProjectCommitOptions,
  ): Promise<AppendProjectBriefResult>;
  commitConceptRevision(
    input: MutationIdentity &
      Readonly<{
        expectedProjectRevision: number;
        project: CreativeProject;
        asset: ConceptAsset;
        assetRevision: ConceptAssetRevision;
      }> &
      (
        | Readonly<{ kind: "create-concept" }>
        | Readonly<{
            kind: "append-concept";
            expectedAssetMetadataRevision: number;
          }>
      ),
    options?: CreativeProjectCommitOptions,
  ): Promise<ChangeConceptAssetResult>;
}
