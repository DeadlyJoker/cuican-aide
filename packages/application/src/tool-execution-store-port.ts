import type {
  RunAttemptState,
  RunStepState,
  ToolExecutionReceiptState,
  ToolExecutionResult,
} from "@crewon/domain";

import type { WorkItemLeaseInput } from "./durable-queue-port.ts";
import type { ModelHistoryAppend } from "./model-history-store-port.ts";
import type { RunAttemptIdentity } from "./run-execution-store-port.ts";
import type { CommitRunInput, CommitRunResult } from "./run-store-port.ts";
import type { TurnStartGoalMutation } from "./thread-goal-store-port.ts";

export type ToolExecutionReceiptLocator = Readonly<{
  tenantId: string;
  runId: string;
  receiptId: string;
}>;

export type ToolExecutionActionLocator = Readonly<{
  tenantId: string;
  runId: string;
  actionDigest: string;
}>;

export type PrepareToolExecutionInput = Readonly<{
  lease: WorkItemLeaseInput;
  receipt: ToolExecutionReceiptState;
}>;

export type ToolExecutionTransition =
  | Readonly<{ kind: "dispatch"; occurredAt: string }>
  | Readonly<{
      kind: "unknownOutcome";
      occurredAt: string;
      providerReceiptId: string | null;
    }>
  | Readonly<{
      kind: "complete";
      occurredAt: string;
      providerReceiptId: string;
      result: ToolExecutionResult;
    }>
  | Readonly<{
      kind: "cancel";
      occurredAt: string;
      providerReceiptId: string | null;
    }>;

export type TransitionToolExecutionInput = ToolExecutionReceiptLocator &
  Readonly<{
    lease: WorkItemLeaseInput;
    expectedRevision: number;
    transition: ToolExecutionTransition;
  }>;

export type CommitToolExecutionCompletionInput = Readonly<{
  lease: WorkItemLeaseInput;
  commit: CommitRunInput;
  goal: TurnStartGoalMutation;
  history: ModelHistoryAppend;
  receipt: ToolExecutionReceiptLocator &
    Readonly<{
      expectedRevision: number;
      providerReceiptId: string;
      result: ToolExecutionResult;
      resolvedAt: string;
    }>;
  attempt: RunAttemptIdentity & Readonly<{ finishedAt: string }>;
}>;

export type CommitToolExecutionCompletionResult = Readonly<{
  run: CommitRunResult;
  receipt: ToolExecutionReceiptState;
  step: RunStepState;
  attempt: RunAttemptState;
}>;

export type CommitToolExecutionUnknownOutcomeInput = Readonly<{
  lease: WorkItemLeaseInput;
  commit: CommitRunInput;
  receipt: ToolExecutionReceiptLocator &
    Readonly<{
      expectedRevision: number;
      providerReceiptId: string | null;
      observedAt: string;
    }>;
  attempt: RunAttemptIdentity & Readonly<{ finishedAt: string }>;
  retryAfterMs: number;
}>;

export type CommitToolExecutionUnknownOutcomeResult = Readonly<{
  run: CommitRunResult;
  receipt: ToolExecutionReceiptState;
  step: RunStepState;
  attempt: RunAttemptState;
}>;

/** Durable authority for external Tool dispatch and reconciliation receipts. */
export interface ToolExecutionStore {
  loadToolExecutionReceipt(
    locator: ToolExecutionReceiptLocator,
  ): Promise<ToolExecutionReceiptState | null>;
  loadToolExecutionReceiptByAction(
    locator: ToolExecutionActionLocator,
  ): Promise<ToolExecutionReceiptState | null>;
  prepareToolExecution(
    input: PrepareToolExecutionInput,
  ): Promise<ToolExecutionReceiptState>;
  transitionToolExecution(
    input: TransitionToolExecutionInput,
  ): Promise<ToolExecutionReceiptState>;
  commitToolExecutionCompletion(
    input: CommitToolExecutionCompletionInput,
  ): Promise<CommitToolExecutionCompletionResult>;
  commitToolExecutionUnknownOutcome(
    input: CommitToolExecutionUnknownOutcomeInput,
  ): Promise<CommitToolExecutionUnknownOutcomeResult>;
}
