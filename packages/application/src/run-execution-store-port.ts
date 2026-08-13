import type {
  RunAttemptState,
  ModelHistoryItem,
  RunLifecycleEvent,
  RunState,
  RunStepKind,
  RunStepState,
  ThreadGoal,
  ThreadState,
} from "@crewon/domain";
import {
  parseProviderCheckpoint,
  type ProviderCheckpoint,
} from "@crewon/contracts/runtime";

import type { WorkItemLeaseInput } from "./durable-queue-port.ts";
import type {
  IdempotencyDescriptor,
  OutboxMessage,
  WorkItem,
  CommitRunInput,
  CommitRunResult,
} from "./run-store-port.ts";
import type { MessageRecord } from "./thread-store-port.ts";
import type { ModelHistoryAppend } from "./model-history-store-port.ts";
import type { TurnStartGoalMutation } from "./thread-goal-store-port.ts";

export type CommitLeasedRunInput = Readonly<{
  lease: WorkItemLeaseInput;
  commit: CommitRunInput;
  history: ModelHistoryAppend | null;
}>;

export type RunStepLocator = Readonly<{
  tenantId: string;
  runId: string;
  stepId: string;
}>;

export type RunAttemptLocator = RunStepLocator &
  Readonly<{
    attemptId: string;
  }>;

export type BeginRunAttemptInput = Readonly<{
  tenantId: string;
  lease: WorkItemLeaseInput;
  runId: string;
  stepId: string;
  kind: RunStepKind;
  attemptId: string;
  startedAt: string;
  mode?: "execute" | "reconcile";
}>;

export type BeginRunAttemptResult = Readonly<{
  step: RunStepState;
  attempt: RunAttemptState;
  abandonedAttempt: RunAttemptState | null;
}>;

export type RunAttemptIdentity = Readonly<{
  stepId: string;
  attemptId: string;
}>;

export type CheckpointRunAttemptInput = Readonly<{
  tenantId: string;
  lease: WorkItemLeaseInput;
  runId: string;
  attempt: RunAttemptIdentity;
  checkpoint: ProviderCheckpoint;
  checkpointDigest: string;
  checkpointedAt: string;
  modelDispatch?: Readonly<{
    operationId: string;
    requestSequence: number;
    expectedRevision: number;
  }>;
}>;

export type RecordRunAttemptProviderTurnStateInput = Readonly<{
  tenantId: string;
  lease: WorkItemLeaseInput;
  runId: string;
  attempt: RunAttemptIdentity;
  providerTurnState: string;
  observedAt: string;
}>;

type RunAttemptFinish = RunAttemptIdentity &
  Readonly<{
    finishedAt: string;
    checkpointDigest: string | null;
    providerTurnState?: string | null;
  }>;

export type RunAttemptCompletionMutation = RunAttemptFinish &
  Readonly<{ status: "completed" }>;
export type RunAttemptCancellationMutation = RunAttemptFinish &
  Readonly<{ status: "canceled" }>;
export type RunAttemptFailureMutation = RunAttemptFinish &
  Readonly<{
    status: "failed";
    failure: Readonly<{ code: string; retryable: boolean }>;
  }>;
export type RunAttemptTerminalMutation =
  | RunAttemptCompletionMutation
  | RunAttemptCancellationMutation
  | RunAttemptFailureMutation;
export type RunAttemptRunTerminalMutation =
  | RunAttemptCancellationMutation
  | RunAttemptFailureMutation;

export type RetryRunAttemptInput = Readonly<{
  tenantId: string;
  lease: WorkItemLeaseInput;
  runId: string;
  attempt: RunAttemptIdentity &
    Readonly<{
      finishedAt: string;
      checkpointDigest: string | null;
      failure: Readonly<{ code: string; retryable: true }>;
    }>;
  retryAfterMs: number;
}>;

export type RunAttemptTransitionResult = Readonly<{
  step: RunStepState;
  attempt: RunAttemptState;
}>;

export type CompleteRunAttemptInput = Readonly<{
  tenantId: string;
  lease: WorkItemLeaseInput;
  runId: string;
  attempt: RunAttemptIdentity &
    Readonly<{
      finishedAt: string;
      checkpointDigest: string | null;
      providerTurnState?: string | null;
    }>;
}>;

export type RunGoalContinuationCommit = Readonly<{
  historyItem: ModelHistoryItem;
  events: readonly RunLifecycleEvent[];
  outbox: readonly OutboxMessage[];
  workItems: readonly WorkItem[];
}>;

export type RunGoalContinuationResult = Readonly<{
  historyItem: ModelHistoryItem;
  runState: RunState;
  runEvents: readonly RunLifecycleEvent[];
  outbox: readonly OutboxMessage[];
  workItems: readonly WorkItem[];
}>;

export type CommitLeasedRunTerminalInput = Readonly<{
  lease: WorkItemLeaseInput;
  commit: CommitRunInput;
  goal: TurnStartGoalMutation;
  attempt: RunAttemptRunTerminalMutation | null;
  history: ModelHistoryAppend | null;
}>;

export type CommitLeasedRunTerminalResult = Readonly<{
  run: CommitRunResult;
  goalState: ThreadGoal | null;
  step: RunStepState | null;
  attempt: RunAttemptState | null;
}>;

export type CommitContextCompactionInput = Readonly<{
  lease: WorkItemLeaseInput;
  commit: CommitRunInput;
  history: ModelHistoryAppend;
  attempt: RunAttemptIdentity & Readonly<{ finishedAt: string }>;
  completion: "continueRun" | "completeRun";
}>;

export type CommitContextCompactionResult = Readonly<{
  run: CommitRunResult;
  step: RunStepState;
  attempt: RunAttemptState;
}>;

/** Atomic nonterminal boundary between provider-requested samples in one Turn. */
export type CommitAssistantSampleContinuationInput = Readonly<{
  lease: WorkItemLeaseInput;
  commit: CommitRunInput;
  history: ModelHistoryAppend;
  modelState: ThreadModelState;
  continuation: ThreadContinuationCheckpoint | null;
  attempt: RunAttemptIdentity &
    Readonly<{
      finishedAt: string;
      checkpointDigest: string | null;
      providerTurnState?: string | null;
    }>;
  sampleIndex: number;
}>;

export type CommitAssistantSampleContinuationResult = Readonly<{
  run: CommitRunResult;
  step: RunStepState;
  attempt: RunAttemptState;
}>;

export type ThreadModelState = Readonly<{
  schemaVersion: "crewon.thread-model-state.v0";
  tenantId: string;
  threadId: string;
  agentVersionId: string;
  adapterName: string;
  adapterVersion: string;
  modelId: string;
  contextWindowTokens: number;
  autoCompactAtTokens: number | null;
  throughHistorySequence: number;
  contextRevision: string;
  latestUsage: Readonly<{
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }> | null;
  updatedAt: string;
}>;

export type CommitTextRunCompletionInput = Readonly<{
  tenantId: string;
  lease: WorkItemLeaseInput;
  idempotency: IdempotencyDescriptor;
  run: Readonly<{
    expectedRevision: number;
    events: readonly RunLifecycleEvent[];
    outbox: readonly OutboxMessage[];
  }>;
  goal: TurnStartGoalMutation;
  goalContinuation: RunGoalContinuationCommit | null;
  thread: Readonly<{
    expectedRevision: number;
    events: readonly import("@crewon/domain").ThreadLifecycleEvent[];
    messages: readonly MessageRecord[];
  }>;
  history: ModelHistoryAppend;
  continuation: Readonly<{
    agentVersionId: string;
    adapterName: string;
    adapterVersion: string;
    modelId: string;
    contextRevision: string;
    checkpoint: ProviderCheckpoint | null;
  }>;
  modelState: ThreadModelState;
  attempt: RunAttemptIdentity &
    Readonly<{
      finishedAt: string;
      checkpointDigest: string | null;
      providerTurnState?: string | null;
    }>;
}>;

export type ThreadContinuationLocator = Readonly<{
  tenantId: string;
  threadId: string;
  agentVersionId: string;
  adapterName: string;
  adapterVersion: string;
  modelId: string;
}>;

export type ThreadContinuationCheckpoint = ThreadContinuationLocator &
  Readonly<{
    throughHistorySequence: number;
    contextRevision: string;
    checkpoint: ProviderCheckpoint;
    updatedAt: string;
  }>;

export function parseExecutionProviderCheckpoint(
  input: unknown,
): ProviderCheckpoint {
  return parseProviderCheckpoint(input);
}

export type CommitTextRunCompletionResult = Readonly<{
  disposition: "committed" | "replayed";
  runState: RunState;
  goalState: ThreadGoal | null;
  goalContinuation: RunGoalContinuationResult | null;
  threadState: ThreadState;
  runEvents: readonly RunLifecycleEvent[];
  threadEvents: readonly import("@crewon/domain").ThreadLifecycleEvent[];
  messages: readonly MessageRecord[];
  historyItems: ModelHistoryAppend["items"];
  outbox: readonly OutboxMessage[];
  continuation: ThreadContinuationCheckpoint | null;
  modelState: ThreadModelState;
  step: RunStepState;
  attempt: RunAttemptState;
}>;

/**
 * Store transactions reserved for a fenced Runtime Worker.
 *
 * Every implementation must validate the current Work Item lease in the same
 * transaction as the domain commit. A lease check performed before the
 * transaction is not sufficient to authorize model or execution writes.
 */
export interface RunExecutionStore {
  loadRunStep(locator: RunStepLocator): Promise<RunStepState | null>;
  loadRunAttempt(locator: RunAttemptLocator): Promise<RunAttemptState | null>;
  listRunAttempts(
    locator: RunStepLocator,
    afterAttemptNumber: number,
    limit: number,
  ): Promise<readonly RunAttemptState[]>;
  loadRunProviderTurnState(
    locator: Readonly<{
      tenantId: string;
      runId: string;
    }>,
  ): Promise<string | null>;
  beginRunAttempt(input: BeginRunAttemptInput): Promise<BeginRunAttemptResult>;
  checkpointRunAttempt(
    input: CheckpointRunAttemptInput,
  ): Promise<RunAttemptState>;
  recordRunAttemptProviderTurnState(
    input: RecordRunAttemptProviderTurnStateInput,
  ): Promise<RunAttemptState>;
  completeRunAttempt(
    input: CompleteRunAttemptInput,
  ): Promise<RunAttemptTransitionResult>;
  retryRunAttempt(
    input: RetryRunAttemptInput,
  ): Promise<RunAttemptTransitionResult>;
  loadThreadContinuation(
    locator: ThreadContinuationLocator,
  ): Promise<ThreadContinuationCheckpoint | null>;
  loadThreadModelState(
    locator: Readonly<{ tenantId: string; threadId: string }>,
  ): Promise<ThreadModelState | null>;
  commitLeasedRun(input: CommitLeasedRunInput): Promise<CommitRunResult>;
  commitLeasedRunTerminal(
    input: CommitLeasedRunTerminalInput,
  ): Promise<CommitLeasedRunTerminalResult>;
  commitContextCompaction(
    input: CommitContextCompactionInput,
  ): Promise<CommitContextCompactionResult>;
  commitAssistantSampleContinuation(
    input: CommitAssistantSampleContinuationInput,
  ): Promise<CommitAssistantSampleContinuationResult>;
  commitTextRunCompletion(
    input: CommitTextRunCompletionInput,
  ): Promise<CommitTextRunCompletionResult>;
}
