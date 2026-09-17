import type { RunLifecycleEvent, RunState } from "@crewon/domain";
import type { WorkItemLeaseInput } from "./durable-queue-port.ts";
import type { IdempotencyDescriptor } from "./run-store-port.ts";

export type RunOutputEvent = Extract<
  RunLifecycleEvent,
  { type: "model.output.delta" }
>;
export type RunProgressEvent = Extract<
  RunLifecycleEvent,
  { type: "segment.started" | "usage.recorded" }
>;
export type RunStreamEvent = RunOutputEvent | RunProgressEvent;

export type RunStreamAppendEntry<E extends RunStreamEvent = RunStreamEvent> =
  Readonly<{
    /** Sequence is a proposal; the Store assigns the next durable sequence to new entries. */
    event: E;
    /** Retains the pre-batching identity so an older committed event can be recognized. */
    idempotency: IdempotencyDescriptor;
  }>;

export type AppendRunStreamEventsInput<
  E extends RunStreamEvent = RunStreamEvent,
> = Readonly<{
  tenantId: string;
  runId: string;
  lease: WorkItemLeaseInput;
  expectedRevision: number;
  entries: readonly RunStreamAppendEntry<E>[];
  notification: Readonly<{ messageId: string; createdAt: string }>;
}>;

export type AppendRunStreamEventsResult<
  E extends RunStreamEvent = RunStreamEvent,
> = Readonly<{
  /** Current authority after this append; this is not public command-response replay. */
  state: RunState;
  appendedEvents: readonly E[];
  replayedCount: number;
}>;

export type RunOutputAppendEntry = RunStreamAppendEntry<RunOutputEvent>;
export type AppendRunOutputEventsInput =
  AppendRunStreamEventsInput<RunOutputEvent>;
export type AppendRunOutputEventsResult =
  AppendRunStreamEventsResult<RunOutputEvent>;
export type AppendRunProgressEventsInput =
  AppendRunStreamEventsInput<RunProgressEvent>;
export type AppendRunProgressEventsResult =
  AppendRunStreamEventsResult<RunProgressEvent>;
