import type {
  ModelDispatchProviderIdentity,
  ModelDispatchReceipt,
  ModelDispatchTerminalOutcome,
} from "@crewon/domain";

import type { WorkItemLeaseInput } from "./durable-queue-port.ts";
import type {
  RunAttemptIdentity,
  RunAttemptLocator,
} from "./run-execution-store-port.ts";

export type PrepareModelDispatchInput = Readonly<{
  tenantId: string;
  runId: string;
  lease: WorkItemLeaseInput;
  attempt: RunAttemptIdentity;
  requestDigest: string;
  provider: ModelDispatchProviderIdentity;
  preparedAt: string;
}>;

export type TransitionModelDispatchInput = Readonly<{
  tenantId: string;
  runId: string;
  lease: WorkItemLeaseInput;
  attempt: RunAttemptIdentity;
  expectedRevision: number;
  transitionedAt: string;
}>;

export type ObserveModelDispatchResponseInput = TransitionModelDispatchInput &
  Readonly<{ checkpointDigest: string }>;

export type TerminateModelDispatchInput = TransitionModelDispatchInput &
  Readonly<{ outcome: ModelDispatchTerminalOutcome }>;

/**
 * Store-owned model dispatch evidence authority.
 *
 * Mutations must fence the current Work Item lease and compare the receipt
 * revision in the same transaction. Implementations replay an already-applied
 * identical mutation and reject immutable or divergent evidence.
 */
export interface ModelDispatchEvidenceStore {
  loadModelDispatchReceipt(
    locator: RunAttemptLocator,
  ): Promise<ModelDispatchReceipt | null>;
  prepareModelDispatch(
    input: PrepareModelDispatchInput,
  ): Promise<ModelDispatchReceipt>;
  markModelDispatchPossiblySent(
    input: TransitionModelDispatchInput,
  ): Promise<ModelDispatchReceipt>;
  observeModelDispatchResponse(
    input: ObserveModelDispatchResponseInput,
  ): Promise<ModelDispatchReceipt>;
  terminateModelDispatch(
    input: TerminateModelDispatchInput,
  ): Promise<ModelDispatchReceipt>;
}
