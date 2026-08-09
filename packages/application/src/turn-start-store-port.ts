import type {
  RunLifecycleEvent,
  RunState,
  ThreadLifecycleEvent,
  ThreadState,
  ThreadGoal,
} from "@crewon/domain";

import type { ModelHistoryAppend } from "./model-history-store-port.ts";
import type {
  IdempotencyDescriptor,
  OutboxMessage,
  WorkItem,
} from "./run-store-port.ts";
import type { MessageRecord } from "./thread-store-port.ts";
import type { TurnStartGoalMutation } from "./thread-goal-store-port.ts";

export type TurnStartReceiptQuery = Readonly<{
  tenantId: string;
  threadId: string;
  idempotency: IdempotencyDescriptor;
}>;

export type CommitTurnStartInput = Readonly<{
  tenantId: string;
  idempotency: IdempotencyDescriptor;
  goal: TurnStartGoalMutation;
  thread: Readonly<{
    expectedRevision: number;
    events: readonly ThreadLifecycleEvent[];
    messages: readonly MessageRecord[];
    history: ModelHistoryAppend;
  }>;
  run: Readonly<{
    expectedRevision: number;
    events: readonly RunLifecycleEvent[];
    outbox: readonly OutboxMessage[];
    workItems: readonly WorkItem[];
  }>;
}>;

export type CommitTurnStartResult = Readonly<{
  disposition: "committed" | "replayed";
  threadState: ThreadState;
  runState: RunState;
  goalState: ThreadGoal | null;
  threadEvents: readonly ThreadLifecycleEvent[];
  messages: readonly MessageRecord[];
  historyItems: ModelHistoryAppend["items"];
  runEvents: readonly RunLifecycleEvent[];
  outbox: readonly OutboxMessage[];
  workItems: readonly WorkItem[];
}>;

/** Atomic authority for admitting one user message and its Run. */
export interface TurnStartStore {
  loadTurnStartReceipt(
    query: TurnStartReceiptQuery,
  ): Promise<CommitTurnStartResult | null>;
  commitTurnStart(input: CommitTurnStartInput): Promise<CommitTurnStartResult>;
}
