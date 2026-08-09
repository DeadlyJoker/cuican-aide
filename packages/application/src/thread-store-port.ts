import type {
  AutomationInvocationOrigin,
  MessageRole,
  ProposedPlan,
  ThreadLifecycleEvent,
  ThreadState,
} from "@crewon/domain";

import type { IdempotencyDescriptor } from "./run-store-port.ts";
import type { ModelHistoryAppend } from "./model-history-store-port.ts";

export type ThreadLocator = Readonly<{
  tenantId: string;
  threadId: string;
}>;

export type ThreadListCursor = Readonly<{
  updatedAt: string;
  threadId: string;
}>;

export type ThreadListQuery = Readonly<{
  tenantId: string;
  spaceId: string;
  before: ThreadListCursor | null;
  limit: number;
}>;

export type MessageRecord = Readonly<{
  messageId: string;
  tenantId: string;
  threadId: string;
  sequence: number;
  role: MessageRole;
  content: string;
  contentDigest: string;
  createdAt: string;
  /** Absent only on legacy reads; every new write must use null or canonical provenance. */
  origin?: AutomationInvocationOrigin | null;
  /** Absent only on pre-projection legacy records; every new write uses null or a complete record. */
  proposedPlan?: ProposedPlan | null;
  /** Present only in the explicit audit view; ordinary writes and standard reads omit it. */
  invalidation?: MessageInvalidation | null;
}>;

export type MessageInvalidation = Readonly<{
  rollbackId: string;
  markerItemId: string;
  historySequence: number;
  invalidatedAt: string;
}>;

export type MessageView = "standard" | "audit";

export type CommitThreadInput = Readonly<{
  tenantId: string;
  idempotency: IdempotencyDescriptor;
  expectedRevision: number;
  events: readonly ThreadLifecycleEvent[];
  messages: readonly MessageRecord[];
  history: ModelHistoryAppend;
  sourceFence?: Readonly<{
    threadId: string;
    spaceId: string;
    expectedRevision: number;
  }>;
  tombstone?: Readonly<{
    expectedActiveRunId: null;
    expectedGoalRevision: number | null;
    occurredAt: string;
  }>;
}>;

export type CommitThreadResult = Readonly<{
  disposition: "committed" | "replayed";
  state: ThreadState;
  events: readonly ThreadLifecycleEvent[];
  messages: readonly MessageRecord[];
  historyItems: ModelHistoryAppend["items"];
}>;

/** Thread and Message persistence authority used by application services. */
export interface ThreadStore {
  loadThread(locator: ThreadLocator): Promise<ThreadState | null>;
  listThreads(query: ThreadListQuery): Promise<readonly ThreadState[]>;
  commitThread(input: CommitThreadInput): Promise<CommitThreadResult>;
  listThreadEvents(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ThreadLifecycleEvent[]>;
  listMessages(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
    view?: MessageView,
  ): Promise<readonly MessageRecord[]>;
}
