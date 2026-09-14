import { createHash } from "node:crypto";
import {
  RunStoreError,
  type AppendRunOutputEventsInput,
  type AppendRunOutputEventsResult,
  type CommitRunResult,
  type OutboxMessage,
  type RunOutputAppendEntry,
  type RunOutputEvent,
} from "@crewon/application";
import { reduceRunLifecycleEvent, type RunState } from "@crewon/domain";
import {
  stableJson,
  validateEvents,
  validateOutbox,
  validateQueueLease,
} from "./store-invariants.ts";

export const MAX_RUN_OUTPUT_BATCH_EVENTS = 32;
export const MAX_RUN_OUTPUT_BATCH_BYTES = 64 * 1024;

export type RunOutputReceipt = Readonly<{
  fingerprint: string;
  runSequence: number;
  eventId: string;
}>;

export type RunOutputAppendPlan = AppendRunOutputEventsResult &
  Readonly<{
    receipts: readonly Readonly<{
      entry: RunOutputAppendEntry;
      receipt: RunOutputReceipt;
    }>[];
    outbox: readonly OutboxMessage[];
  }>;

export function runOutputFingerprint(entry: RunOutputAppendEntry): string {
  return `crewon.run-output-fingerprint.v1:sha256:${createHash("sha256")
    .update(
      stableJson({
        type: entry.event.type,
        identity: entry.event.identity,
        data: entry.event.data,
        idempotency: entry.idempotency,
      }),
    )
    .digest("hex")}`;
}

export function validateRunOutputAppend(
  input: AppendRunOutputEventsInput,
): void {
  validateQueueLease(
    input.lease,
    input.lease.workItemId,
    "work_item_id_invalid",
  );
  if (
    input.tenantId.trim().length === 0 ||
    input.runId.trim().length === 0 ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    input.entries.length < 1 ||
    input.entries.length > MAX_RUN_OUTPUT_BATCH_EVENTS
  )
    throw new RunStoreError("run_output_batch_invalid");
  let lastSourceSequence = 0;
  let bytes = 0;
  const segmentId = input.entries[0]!.event.data.segmentId;
  for (const entry of input.entries) {
    const event = entry.event;
    if (
      event.type !== "model.output.delta" ||
      event.identity.runId !== input.runId ||
      event.data.segmentId !== segmentId ||
      !Number.isSafeInteger(event.data.segmentSequence) ||
      event.data.segmentSequence <= lastSourceSequence ||
      entry.idempotency.scope.length === 0 ||
      entry.idempotency.key.length === 0 ||
      entry.idempotency.requestFingerprint.length === 0
    )
      throw new RunStoreError("run_output_batch_invalid");
    lastSourceSequence = event.data.segmentSequence;
    bytes += Buffer.byteLength(stableJson(event), "utf8");
  }
  if (
    bytes > MAX_RUN_OUTPUT_BATCH_BYTES ||
    Buffer.byteLength(stableJson(input), "utf8") > 256 * 1024
  ) {
    throw new RunStoreError("run_output_batch_too_large");
  }
}

/** Validates the old exact receipt without migrating or rewriting its public response. */
export function legacyRunOutputReceipt(
  input: AppendRunOutputEventsInput,
  entry: RunOutputAppendEntry,
  prior: Readonly<{
    tenantId: string;
    runId: string;
    fingerprint: string;
    result: CommitRunResult;
  }> | null,
): RunOutputReceipt | null {
  if (prior === null) return null;
  if (prior.tenantId !== input.tenantId || prior.runId !== input.runId)
    throw new RunStoreError("tenant_id_mismatch");
  const event = prior.result.events[0];
  if (
    prior.fingerprint !== entry.idempotency.requestFingerprint ||
    prior.result.state.runId !== input.runId ||
    prior.result.state.tenantId !== input.tenantId ||
    prior.result.events.length !== 1 ||
    event?.identity.runId !== input.runId ||
    event.type !== entry.event.type ||
    stableJson(event.data) !== stableJson(entry.event.data) ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1
  )
    throw new RunStoreError("idempotency_conflict");
  return {
    fingerprint: runOutputFingerprint(entry),
    runSequence: event.sequence,
    eventId: event.eventId,
  };
}

/** Call while holding the Run write lock and its current lease; all checks precede mutation. */
export function prepareRunOutputAppend(
  current: RunState,
  input: AppendRunOutputEventsInput,
  priorReceipts: readonly (RunOutputReceipt | null)[],
  exists: Readonly<{
    eventId: (id: string) => boolean;
    outboxId: (id: string) => boolean;
    lastSourceSequence: number;
  }>,
): RunOutputAppendPlan {
  if (current.tenantId !== input.tenantId || current.runId !== input.runId)
    throw new RunStoreError("tenant_id_mismatch");
  if (priorReceipts.length !== input.entries.length)
    throw new RunStoreError("run_output_receipts_invalid");
  const receipts: RunOutputAppendPlan["receipts"][number][] = [];
  const appendedEvents: RunOutputEvent[] = [];
  let replayedCount = 0;
  let lastReplaySequence = 0;
  for (const [index, entry] of input.entries.entries()) {
    const fingerprint = runOutputFingerprint(entry);
    const prior = priorReceipts[index];
    if (prior !== null && prior !== undefined) {
      if (prior.fingerprint !== fingerprint)
        throw new RunStoreError("idempotency_conflict");
      if (
        appendedEvents.length > 0 ||
        prior.runSequence <= lastReplaySequence ||
        prior.runSequence > current.lastSequence
      )
        throw new RunStoreError("run_output_replay_order_invalid");
      lastReplaySequence = prior.runSequence;
      replayedCount += 1;
      receipts.push({ entry, receipt: prior });
      continue;
    }
    if (entry.event.data.segmentSequence <= exists.lastSourceSequence)
      throw new RunStoreError("run_output_replay_order_invalid");
    const event = {
      ...entry.event,
      sequence: current.lastSequence + appendedEvents.length + 1,
    };
    appendedEvents.push(event);
    receipts.push({
      entry,
      receipt: {
        fingerprint,
        runSequence: event.sequence,
        eventId: event.eventId,
      },
    });
  }
  let state = current;
  const outbox: OutboxMessage[] = [];
  if (appendedEvents.length > 0) {
    if (current.revision !== input.expectedRevision)
      throw new RunStoreError("revision_conflict");
    if (current.cancelRequested)
      throw new RunStoreError("execution_cancel_pending");
    if (current.status !== "running")
      throw new RunStoreError("run_not_running");
    validateEvents(appendedEvents, input.runId, exists.eventId);
    for (const event of appendedEvents)
      state = reduceRunLifecycleEvent(state, event);
    const first = appendedEvents[0]!;
    const last = appendedEvents.at(-1)!;
    outbox.push({
      ...input.notification,
      tenantId: input.tenantId,
      runId: input.runId,
      topic: "run.events.available",
      payload: {
        schemaVersion: "crewon.run-event-range.v0",
        fromSequence: first.sequence,
        throughSequence: last.sequence,
        firstEventId: first.eventId,
        lastEventId: last.eventId,
      },
    });
    validateOutbox(outbox, input.runId, input.tenantId, exists.outboxId);
  }
  return { state, appendedEvents, replayedCount, receipts, outbox };
}
