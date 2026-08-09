import type {
  ModelHistoryItem,
  RunLifecycleEvent,
  RunState,
  ThreadGoal,
  ThreadGoalEvent,
} from "@crewon/domain";

import type { ModelHistoryAppend } from "./model-history-store-port.ts";
import type {
  IdempotencyDescriptor,
  OutboxMessage,
  WorkItem,
} from "./run-store-port.ts";

export type ThreadGoalLocator = Readonly<{
  tenantId: string;
  threadId: string;
}>;

export type ThreadGoalSnapshot = Readonly<{
  goal: ThreadGoal | null;
  eventSequence: number;
}>;

/** Persistent per-Thread Goal authority. */
export interface ThreadGoalStore {
  loadThreadGoal(locator: ThreadGoalLocator): Promise<ThreadGoal | null>;
}

/** Atomic Goal projection and durable-event cursor handoff authority. */
export interface ThreadGoalSnapshotStore {
  loadThreadGoalSnapshot(
    locator: ThreadGoalLocator,
  ): Promise<ThreadGoalSnapshot>;
}

/** Durable catch-up authority for Thread Goal lifecycle notifications. */
export interface ThreadGoalEventStore {
  listThreadGoalEvents(
    locator: ThreadGoalLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ThreadGoalEvent[]>;
}

export type ThreadGoalActiveRunFence = Readonly<{
  runId: string;
  expectedRevision: number;
}> | null;

export type ThreadGoalActiveRun = Readonly<{
  state: RunState;
  trigger: "default" | "goalContinuation" | "goalActivation";
}>;

export type ThreadGoalQueuedRunCancellation = Readonly<{
  events: readonly RunLifecycleEvent[];
  outbox: readonly OutboxMessage[];
}>;

export type ThreadGoalRetainedRunUpdate = Readonly<{
  events: readonly RunLifecycleEvent[];
  outbox: readonly OutboxMessage[];
}>;

export type ThreadGoalContinuation = Readonly<{
  history: ModelHistoryAppend;
  events: readonly RunLifecycleEvent[];
  outbox: readonly OutboxMessage[];
  workItems: readonly WorkItem[];
}>;

export type CommitThreadGoalMutationInput = Readonly<{
  tenantId: string;
  threadId: string;
  idempotency: IdempotencyDescriptor;
  goal: TurnStartGoalMutation;
  expectedActiveRun: ThreadGoalActiveRunFence;
  queuedRunCancellation: ThreadGoalQueuedRunCancellation | null;
  retainedRunUpdate: ThreadGoalRetainedRunUpdate | null;
  continuation: ThreadGoalContinuation | null;
}>;

export type CommitThreadGoalMutationResult = Readonly<{
  disposition: "committed" | "replayed";
  goalChanged: boolean;
  goalState: ThreadGoal | null;
  canceledRunState: RunState | null;
  retainedRun: Readonly<{
    runState: RunState;
    runEvents: readonly RunLifecycleEvent[];
    outbox: readonly OutboxMessage[];
  }> | null;
  continuation: Readonly<{
    historyItem: ModelHistoryItem;
    runState: RunState;
    runEvents: readonly RunLifecycleEvent[];
    outbox: readonly OutboxMessage[];
    workItems: readonly WorkItem[];
  }> | null;
}>;

/**
 * Atomic user-owned Goal mutation authority.
 *
 * Implementations fence the current non-terminal Run, retire an incompatible
 * queued Run and its Work Item, and admit a replacement Goal continuation in
 * the same transaction as the Goal CAS and idempotency receipt.
 */
export interface ThreadGoalMutationStore {
  loadThreadGoalMutationReceipt(input: {
    tenantId: string;
    threadId: string;
    idempotency: IdempotencyDescriptor;
  }): Promise<CommitThreadGoalMutationResult | null>;
  loadThreadActiveRun(
    locator: ThreadGoalLocator,
  ): Promise<ThreadGoalActiveRun | null>;
  commitThreadGoalMutation(
    input: CommitThreadGoalMutationInput,
  ): Promise<CommitThreadGoalMutationResult>;
}

export type TurnStartGoalMutation =
  | Readonly<{ kind: "keep"; expectedRevision: number | null }>
  | Readonly<{
      kind: "set";
      expectedRevision: number | null;
      goal: ThreadGoal;
    }>
  | Readonly<{
      kind: "clear";
      expectedRevision: number | null;
      occurredAt: string;
    }>;
