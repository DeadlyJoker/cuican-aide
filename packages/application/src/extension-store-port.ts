import type {
  ExtensionActivation,
  ExtensionConfiguration,
  ExtensionRunBinding,
  ExtensionScope,
  ExtensionCreditAdmission,
} from "@crewon/domain";
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
