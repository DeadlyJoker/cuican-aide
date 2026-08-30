import type { RunLifecycleEvent, RunState } from "@crewon/domain";

import type {
  DurableQueueStore,
  OutboxMessage,
  WorkItem,
} from "./durable-queue-port.ts";

export type { OutboxMessage, WorkItem } from "./durable-queue-port.ts";

export type RunLocator = Readonly<{
  tenantId: string;
  runId: string;
}>;

export type RunScopedLocator = RunLocator &
  Readonly<{
    spaceId: string;
  }>;

export type ThreadRunListCursor = Readonly<{
  updatedAt: string;
  runId: string;
}>;

export type ThreadRunListQuery = Readonly<{
  tenantId: string;
  spaceId: string;
  threadId: string;
  before: ThreadRunListCursor | null;
  limit: number;
}>;

export type IdempotencyDescriptor = Readonly<{
  scope: string;
  key: string;
  requestFingerprint: string;
}>;

export type RunReceiptQuery = Readonly<{
  tenantId: string;
  threadId: string;
  idempotency: IdempotencyDescriptor;
}>;

export type ManualCompactionAdmission = Readonly<{
  kind: "manualCompaction";
  threadId: string;
  expectedThreadRevision: number;
  expectedHistorySequence: number;
  expectedGoalRevision: number | null;
}>;

export type CommitRunInput = Readonly<{
  tenantId: string;
  idempotency: IdempotencyDescriptor;
  expectedRevision: number;
  events: readonly RunLifecycleEvent[];
  outbox: readonly OutboxMessage[];
  workItems: readonly WorkItem[];
  threadAdmission?: ManualCompactionAdmission;
}>;

export type CommitRunResult = Readonly<{
  disposition: "committed" | "replayed";
  state: RunState;
  events: readonly RunLifecycleEvent[];
  outbox: readonly OutboxMessage[];
  workItems: readonly WorkItem[];
}>;

/** Receipt-first replay authority for commands that resolve runtime routes lazily. */
export interface RunReceiptStore {
  loadRunReceipt(query: RunReceiptQuery): Promise<CommitRunResult | null>;
}

export interface RunStore extends DurableQueueStore {
  close(): Promise<void>;
  loadRun(locator: RunLocator): Promise<RunState | null>;
  /** User-facing read fence that rejects cross-space Run snapshots in Store. */
  loadRunInSpace(locator: RunScopedLocator): Promise<RunState | null>;
  listThreadRuns(query: ThreadRunListQuery): Promise<readonly RunState[]>;
  commitRun(input: CommitRunInput): Promise<CommitRunResult>;
  listRunEvents(
    locator: RunLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly RunLifecycleEvent[]>;
}

export class RunStoreError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "RunStoreError";
    this.code = code;
  }
}
