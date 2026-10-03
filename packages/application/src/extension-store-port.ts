import type {
  ExtensionActivation,
  ExtensionConfiguration,
  ExtensionRunBinding,
  ExtensionScope,
  ExtensionCreditAdmission,
  PluginTaskAdmission,
  PluginQueryTaskAdmission,
  ProjectGenerationReference,
  ProjectGenerationLink,
  ProjectQueryReference,
  ProjectQueryLink,
} from "@crewon/domain";
import type {
  CreativeProjectCommitAuthority,
  CreativeProjectOwnerScope,
} from "./creative-project-store-port.ts";
import type { ProjectGenerationExecutionPublication } from "./project-generation-execution-authority.ts";
import type { ProjectQueryExecutionPublication } from "./project-query-execution-authority.ts";
import type { CommitRunInput, CommitRunResult } from "./run-store-port.ts";
import type {
  CommitTurnStartInput,
  CommitTurnStartResult,
} from "./turn-start-store-port.ts";

export type ExtensionMutationReceipt = Readonly<{
  actorId: string;
  idempotencyKey: string;
  requestDigest: string;
}>;
export type SaveExtensionConfigurationInput = Readonly<{
  configuration: ExtensionConfiguration;
  expectedRevision: number;
  receipt: ExtensionMutationReceipt;
}>;
export type SaveExtensionActivationInput = Readonly<{
  activation: ExtensionActivation;
  expectedRevision: number;
  receipt: ExtensionMutationReceipt;
}>;
export type SaveExtensionConfigurationResult = Readonly<{
  disposition: "created" | "replayed";
  configuration: ExtensionConfiguration;
}>;
export type SaveExtensionActivationResult = Readonly<{
  disposition: "updated" | "replayed";
  activation: ExtensionActivation;
}>;
export type ExtensionRunLocator = Readonly<{
  tenantId: string;
  spaceId: string;
  runId: string;
}>;
/** A saved input selected by the authorized project owner; never a caller-selected execution Run. */
export type ProjectGenerationSourceLocator = Readonly<{
  owner: CreativeProjectOwnerScope;
  projectId: string;
  assetId: string;
  assetRevision: number;
}>;
export type CommitExtensionRunInput = Readonly<{
  commit: CommitRunInput;
  /** Store verifies that both this binding and the created Run describe the same immutable target. */
  binding: ExtensionRunBinding;
  expectedActivationRevision: number;
  receipt: ExtensionMutationReceipt;
}>;
export type CommitExtensionRunResult = Readonly<{
  run: CommitRunResult;
  binding: ExtensionRunBinding;
  /** Present only for a newly priced generation; old receipts remain unchanged. */
  creditAdmission?: ExtensionCreditAdmission;
}>;
export type CommitExtensionTurnInput = Readonly<{
  turn: CommitTurnStartInput;
  binding: ExtensionRunBinding;
  expectedActivationRevision: number;
  receipt: ExtensionMutationReceipt;
  /** Server-derived payer and quote; frozen in the same transaction as the user Turn. */
  creditAdmission?: ExtensionCreditAdmission;
  /** Internal server-derived v1 pin; persisted separately without changing the v0 binding or receipt shape. */
  pluginAdmission?: PluginTaskAdmission;
  pluginQueryAdmission?: PluginQueryTaskAdmission;
  /** Internal confirmed project source; committed atomically with the original Turn and credits. */
  projectGeneration?: ProjectGenerationReference;
  /** Historical source selected by the actual project owner; no metadata CAS or new generation slot. */
  projectQuery?: Readonly<{
    reference: ProjectQueryReference;
    generationLinkDigest: string;
  }>;
}>;
export type CommitExtensionTurnOptions = Readonly<{
  /** Trusted per-invocation callbacks, never captured as JSON in the input or receipt. */
  projectGenerationAuthority?: CreativeProjectCommitAuthority;
  /** Detached source and execution installation pins; the Store locks both using its existing connection. */
  projectGenerationPublication?: ProjectGenerationExecutionPublication;
  /** Transaction-safe identity/policy fences; must never borrow a second connection. */
  projectQueryAuthority?: CreativeProjectCommitAuthority;
  /** Current business UI and query execution pins, separately from original generation provenance. */
  projectQueryPublication?: ProjectQueryExecutionPublication;
}>;
/** Adds the admitted user message and history to the existing immutable task receipt. */
export type CommitExtensionTurnResult = CommitExtensionRunResult &
  Readonly<{
    schemaVersion: "crewon.extension-turn-admission.v0";
    turn: CommitTurnStartResult;
  }>;

/**
 * Persistence for authorized host use cases. The caller must verify actor permission,
 * manifest/configuration compatibility and runtime readiness before activation/admission.
 * Ordinary RunStore writes cannot attach a plugin after dispatch.
 */
export interface ExtensionStore {
  /** Older adapters cannot silently accept a paid task without reserving its credits. */
  readonly creditAdmissionVersion?: "crewon.extension-credit-admission.v0";
  readonly pluginAdmissionVersion?: "crewon.plugin-task-admission.v1";
  readonly pluginQueryAdmissionVersion?: "crewon.plugin-query-task-admission.v1";
  readonly projectGenerationVersion?: "crewon.project-generation-link.v0";
  /** Explicit support for two installed owners; absent on older adapters and before generation opt-in. */
  readonly projectGenerationPublicationVersion?: "crewon.project-generation-publication.v1";
  /** Separate read-only opt-in; it does not grant generation writes or create any schema. */
  readonly projectGenerationReadVersion?: "crewon.project-generation-read.v1";
  readonly projectQueryVersion?: "crewon.project-query-link.v1";
  readonly projectQueryPublicationVersion?: "crewon.project-query-publication.v1";
  loadProjectQueryLink?(
    input: ExtensionRunLocator,
  ): Promise<ProjectQueryLink | null>;
  loadProjectGenerationLinkBySource?(
    input: ProjectGenerationSourceLocator,
  ): Promise<ProjectGenerationLink | null>;
  loadProjectGenerationLink?(
    input: ExtensionRunLocator,
  ): Promise<ProjectGenerationLink | null>;
  loadPluginQueryTaskAdmission?(
    input: ExtensionRunLocator,
  ): Promise<PluginQueryTaskAdmission | null>;
  loadPluginTaskAdmission?(
    input: ExtensionRunLocator,
  ): Promise<PluginTaskAdmission | null>;
  saveExtensionConfiguration(
    input: SaveExtensionConfigurationInput,
  ): Promise<SaveExtensionConfigurationResult>;
  loadExtensionConfiguration(
    input: ExtensionScope & { revision: number },
  ): Promise<ExtensionConfiguration | null>;
  loadLatestExtensionConfiguration(
    input: ExtensionScope,
  ): Promise<ExtensionConfiguration | null>;
  loadExtensionConfigurationReceipt(
    input: ExtensionScope & { receipt: ExtensionMutationReceipt },
  ): Promise<ExtensionConfiguration | null>;
  saveExtensionActivation(
    input: SaveExtensionActivationInput,
  ): Promise<SaveExtensionActivationResult>;
  loadExtensionActivation(
    input: ExtensionScope,
  ): Promise<ExtensionActivation | null>;
  loadExtensionActivationReceipt(
    input: ExtensionScope & { receipt: ExtensionMutationReceipt },
  ): Promise<ExtensionActivation | null>;
  commitExtensionRun(
    input: CommitExtensionRunInput,
  ): Promise<CommitExtensionRunResult>;
  commitExtensionTurn(
    input: CommitExtensionTurnInput,
    options?: CommitExtensionTurnOptions,
  ): Promise<CommitExtensionTurnResult>;
  loadExtensionTurnReceipt(
    input: ExtensionScope & { receipt: ExtensionMutationReceipt },
  ): Promise<CommitExtensionTurnResult | null>;
  loadExtensionRunReceipt(
    input: ExtensionScope & { receipt: ExtensionMutationReceipt },
  ): Promise<CommitExtensionRunResult | null>;
  loadExtensionRunBinding(
    input: ExtensionRunLocator,
  ): Promise<ExtensionRunBinding | null>;
}
