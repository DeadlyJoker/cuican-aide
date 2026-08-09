import type {
  ModelHistoryRollbackMarker,
  ThreadLifecycleEvent,
  ThreadState,
} from "@crewon/domain";

import type { IdempotencyDescriptor } from "./run-store-port.ts";
import type { MessageInvalidation } from "./thread-store-port.ts";

export type ThreadRollbackReceiptQuery = Readonly<{
  tenantId: string;
  threadId: string;
  idempotency: IdempotencyDescriptor;
}>;

export type CommitThreadRollbackInput = Readonly<{
  tenantId: string;
  idempotency: IdempotencyDescriptor;
  expectedThreadRevision: number;
  expectedHistorySequence: number;
  event: Extract<ThreadLifecycleEvent, { type: "thread.rolled_back" }>;
  marker: ModelHistoryRollbackMarker;
}>;

export type InvalidatedMessage = Readonly<{
  messageId: string;
  messageSequence: number;
  invalidation: MessageInvalidation;
}>;

export type CommitThreadRollbackResult = Readonly<{
  disposition: "committed" | "replayed";
  state: ThreadState;
  event: Extract<ThreadLifecycleEvent, { type: "thread.rolled_back" }>;
  marker: ModelHistoryRollbackMarker;
  invalidatedMessages: readonly InvalidatedMessage[];
  invalidatedContinuationCount: number;
  invalidatedModelState: boolean;
}>;

/** Atomic append-only rollback persistence authority. */
export interface ThreadRollbackStore {
  loadThreadRollbackReceipt(
    query: ThreadRollbackReceiptQuery,
  ): Promise<CommitThreadRollbackResult | null>;
  commitThreadRollback(
    input: CommitThreadRollbackInput,
  ): Promise<CommitThreadRollbackResult>;
}
