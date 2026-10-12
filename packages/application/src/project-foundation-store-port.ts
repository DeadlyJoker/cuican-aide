import type {
  CreativeProject,
  InstalledPluginPackage,
  PluginSelection,
  PluginTaskAdmissionPin,
  ProjectBriefRevision,
  ProjectFoundation,
  ProjectProposal,
  ProjectSource,
  ProjectSourceChapter,
  ProjectSourceChunk,
  ProjectSourcePage,
} from "@crewon/domain";
import type { PluginProjectReadScope } from "./plugin-project-read-scope.ts";
import type { ActorContext } from "./authorization-port.ts";
import type {
  CreativeProjectMutationReceipt,
  CreativeProjectOwnerScope,
} from "./creative-project-store-port.ts";
import type { ProjectSourceUploadPreparedPointer } from "./project-source-upload-port.ts";
import type { ProjectFoundationRunCommitTransactionAuthority } from "./project-foundation-run-commit-authority.ts";

export type ProjectFoundationMutationKind =
  | "create-project"
  | "update-parameters"
  | "append-source"
  | "save-proposal"
  | "confirm-proposal"
  | "choose-direct-script";

export type ProjectFoundationChangeKind = Exclude<
  ProjectFoundationMutationKind,
  "create-project" | "save-proposal"
>;

export type ProjectFoundationReadScope = Readonly<{
  owner: CreativeProjectOwnerScope;
  projectId: string;
}>;

export type ProjectFoundationMutationIdentity = Readonly<{
  actor: ActorContext;
  kind: ProjectFoundationMutationKind;
  receipt: CreativeProjectMutationReceipt;
}>;

/** Independent protocol: the old creative-project mutation pin cannot qualify these writes. */
export type ProjectFoundationPluginCommitTransactionAuthority = Readonly<{
  version: "crewon.project-foundation-plugin-commit.v1";
  pin: PluginTaskAdmissionPin;
  selection: PluginSelection;
  package: InstalledPluginPackage;
  /** Live external policy only; never borrow the committing Store's connection or pool. */
  assertCurrent(): Promise<void>;
}>;

export type ProjectFoundationCommitAuthority = Readonly<{
  assertCurrent(): Promise<void>;
  /** Must finish synchronously before COMMIT dispatch; a Promise establishes no authority. */
  assertActive(): void;
  transaction?: ProjectFoundationPluginCommitTransactionAuthority;
  /** Independent original Run/Tool qualification; mutually exclusive with the manual UI pin. */
  runTransaction?: ProjectFoundationRunCommitTransactionAuthority;
}>;

export type ProjectFoundationCommitOptions = Readonly<{
  authority?: ProjectFoundationCommitAuthority;
}>;

/** Immutable committed facts, including on replay; never a caller-issued proof of authorization. */
export type ProjectFoundationMutationResult = Readonly<{
  kind: ProjectFoundationMutationKind;
  disposition: "committed" | "replayed";
  project: CreativeProject;
  foundation: ProjectFoundation;
  brief: ProjectBriefRevision | null;
  source: ProjectSource | null;
  proposal: ProjectProposal | null;
}>;

type MutationInput = Readonly<{
  actor: ActorContext;
  receipt: CreativeProjectMutationReceipt;
}>;

type SourceRecords = Readonly<{
  source: ProjectSource | null;
  /** Trusted ingestion recipe, not a public request or a model-visible payload. */
  chunks: readonly ProjectSourceChunk[];
  chapters: readonly ProjectSourceChapter[];
  /** Internal ledger locator, requalified atomically by the same host transaction. */
  sourceUpload?: ProjectSourceUploadPreparedPointer;
}>;

/**
 * Same original project identity and host-owned database. Construction neither migrates nor
 * creates a project, Thread, Run, execution peer or supplier request. Reads join the actual
 * original project's owner and scope. Every commit re-reads owner/state, compares revisions,
 * verifies immutable dependencies and writes its independent actor-scoped receipt atomically.
 * Installation qualification and final liveness checks apply to replay publication as well.
 * A confirmed COMMIT is not rejected because authority is subsequently withdrawn.
 */
export interface ProjectFoundationStore {
  /** Original immutable dependency reader, bound to one qualified project source. */
  bindProjectReads?(
    scope: PluginProjectReadScope,
  ): Pick<
    ProjectFoundationStore,
    | "loadFoundation"
    | "loadSource"
    | "readSourcePage"
    | "listSourceChapters"
    | "loadProposal"
    | "listProposals"
  >;
  /** null means no attached foundation; it never creates or classifies an existing project. */
  loadFoundation(
    input: ProjectFoundationReadScope,
  ): Promise<ProjectFoundation | null>;
  loadSource(
    input: ProjectFoundationReadScope & Readonly<{ revision: number }>,
  ): Promise<ProjectSource | null>;
  /** Immutable source chapter index, independent of the produced episodes. */
  listSourceChapters(
    input: ProjectFoundationReadScope &
      Readonly<{
        revision: number;
        digest: string;
        afterStartOffset: number | null;
        limit: number;
      }>,
  ): Promise<
    Readonly<{
      chapters: readonly ProjectSourceChapter[];
      nextStartOffset: number | null;
    }>
  >;
  /** Verify the requested manifest/chunk digests and return a bounded Unicode scalar page. */
  readSourcePage(
    input: ProjectFoundationReadScope &
      Readonly<{
        revision: number;
        digest: string;
        startOffset: number;
        limit: number;
      }>,
  ): Promise<ProjectSourcePage>;
  loadProposal(
    input: ProjectFoundationReadScope & Readonly<{ revision: number }>,
  ): Promise<ProjectProposal | null>;
  listProposals(
    input: ProjectFoundationReadScope &
      Readonly<{ afterRevision: number; limit: number }>,
  ): Promise<
    Readonly<{
      /** Ascending immutable proposal revision, strictly after the requested cursor. */
      proposals: readonly ProjectProposal[];
      /** Last delivered revision when another page exists; null when exhausted. */
      nextRevision: number | null;
    }>
  >;
  loadMutationReceipt(
    input: ProjectFoundationMutationIdentity,
    options?: ProjectFoundationCommitOptions,
  ): Promise<ProjectFoundationMutationResult | null>;
  /**
   * One transaction inserts the unchanged v0 project shape, initial brief, attached foundation,
   * all source records and the new receipt. Never call the old public createProject first.
   * Replayed receipts are checked before a newly generated projectId can be persisted.
   */
  commitCreation(
    input: MutationInput &
      SourceRecords &
      Readonly<{
        project: CreativeProject;
        initialBrief: ProjectBriefRevision;
        foundation: ProjectFoundation;
      }>,
    options?: ProjectFoundationCommitOptions,
  ): Promise<ProjectFoundationMutationResult>;
  /** Re-read current foundation and perform CAS; sources/proposals must match the exact kind. */
  commitFoundationChange(
    input: MutationInput &
      SourceRecords &
      Readonly<{
        kind: ProjectFoundationChangeKind;
        expectedFoundationRevision: number;
        foundation: ProjectFoundation;
        proposal: ProjectProposal | null;
      }>,
    options?: ProjectFoundationCommitOptions,
  ): Promise<ProjectFoundationMutationResult>;
  /**
   * Appends an immutable proposal without changing foundation.revision or confirming it.
   * Under the same project lock, require the captured foundation revision and proposal.revision
   * equal to the stored latest proposal revision plus one. No history is overwritten.
   */
  commitProposal(
    input: MutationInput &
      Readonly<{
        project: CreativeProject;
        foundation: ProjectFoundation;
        expectedFoundationRevision: number;
        proposal: ProjectProposal;
      }>,
    options?: ProjectFoundationCommitOptions,
  ): Promise<ProjectFoundationMutationResult>;
}
