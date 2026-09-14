import type { RunLifecycleEvent, RunState } from "@crewon/domain";
import type { WorkItemLeaseInput } from "./durable-queue-port.ts";
import type { IdempotencyDescriptor } from "./run-store-port.ts";

export type RunOutputEvent = Extract<
  RunLifecycleEvent,
  { type: "model.output.delta" }
>;

export type RunOutputAppendEntry = Readonly<{
  /** Sequence is a proposal; the Store assigns the next durable sequence to new entries. */
  event: RunOutputEvent;
  /** Retains the pre-batching identity so an older committed event can be recognized. */
  idempotency: IdempotencyDescriptor;
}>;

export type AppendRunOutputEventsInput = Readonly<{
  tenantId: string;
  runId: string;
  lease: WorkItemLeaseInput;
  expectedRevision: number;
  entries: readonly RunOutputAppendEntry[];
  notification: Readonly<{ messageId: string; createdAt: string }>;
}>;

export type AppendRunOutputEventsResult = Readonly<{
  /** Current authority after this append; this is not public command-response replay. */
  state: RunState;
  appendedEvents: readonly RunOutputEvent[];
  replayedCount: number;
}>;
