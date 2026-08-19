import { DatabaseSync } from "node:sqlite";

import {
  canonicalJson,
  projectWorkflowRetrievedContinuationEvent,
  RunStoreError,
  validateWorkflowRetrievedContinuationPayload,
  type WorkflowRetrievedContinuationPayload,
} from "@crewon/application";
import {
  reduceRunLifecycleEvent,
  type RunLifecycleEvent,
  type RunState,
  type WorkflowContentDigester,
} from "@crewon/domain";

import { stableJson } from "./store-invariants.ts";
import { normalizeStoredRunState } from "./stored-run-state.ts";

/**
 * Appends only the missing durable suffix of one retrieved model segment.
 *
 * The caller owns the surrounding `BEGIN IMMEDIATE` transaction. Existing
 * events must be an exact semantic prefix. Their global Run sequence, event ID
 * and timestamp may differ because the expired Worker can persist that prefix
 * before its response checkpoint becomes recoverable.
 */
export function appendSqliteWorkflowRetrievedEventSuffix(
  database: DatabaseSync,
  input: Readonly<{
    tenantId: string;
    runId: string;
    attemptId: string;
    dispatchOperationId: string;
    segmentId: string;
    payload: WorkflowRetrievedContinuationPayload;
    committedAt: string;
    digester: WorkflowContentDigester;
  }>,
): Readonly<{
  run: RunState;
  appended: readonly RunLifecycleEvent[];
}> {
  const payload = validateWorkflowRetrievedContinuationPayload(input.payload);
  const events = payload.events;
  const existing = loadSegmentEvents(database, input);
  if (existing.length > events.length) corrupt();

  const expected = events.map((event, index) =>
    projectWorkflowRetrievedContinuationEvent(
      event,
      index + 1,
      `retrieved-prefix-${index + 1}`,
      input.committedAt,
      (checkpoint) => input.digester.sha256(canonicalJson(checkpoint)),
    ),
  );
  for (let index = 0; index < existing.length; index += 1) {
    if (eventSemantics(existing[index]!) !== eventSemantics(expected[index]!))
      corrupt();
  }

  const current = loadRun(database, input.tenantId, input.runId);
  let next = current;
  const appended: RunLifecycleEvent[] = [];
  for (let index = existing.length; index < events.length; index += 1) {
    const source = events[index]!;
    const eventId = deterministicId(input, "event", source);
    const event = projectWorkflowRetrievedContinuationEvent(
      source,
      next.lastSequence + 1,
      eventId,
      input.committedAt,
      (checkpoint) => input.digester.sha256(canonicalJson(checkpoint)),
    );
    validateProjectedEvent(input, source.sequence, event);
    next = reduceRunLifecycleEvent(next, event);
    insertEvent(database, input.tenantId, event);
    insertOutbox(database, input, event);
    appended.push(event);
  }
  if (appended.length > 0)
    updateRun(database, current, next, input.committedAt);
  return { run: next, appended };
}

function loadSegmentEvents(
  database: DatabaseSync,
  input: Pick<
    Parameters<typeof appendSqliteWorkflowRetrievedEventSuffix>[1],
    "tenantId" | "runId" | "segmentId"
  >,
): readonly RunLifecycleEvent[] {
  const rows = database
    .prepare(
      `SELECT tenant_id,run_id,sequence,event_id,event_json FROM run_events
       WHERE tenant_id=? AND run_id=?
         AND json_extract(event_json,'$.data.segmentId')=?
       ORDER BY CAST(json_extract(event_json,'$.data.segmentSequence') AS INTEGER),
                sequence`,
    )
    .all(input.tenantId, input.runId, input.segmentId) as unknown as {
    tenant_id: string;
    run_id: string;
    sequence: number;
    event_id: string;
    event_json: string;
  }[];
  return rows.map((row) => decodeSegmentEventRow(row, input));
}

function decodeSegmentEventRow(
  row: Readonly<{
    tenant_id: string;
    run_id: string;
    sequence: number;
    event_id: string;
    event_json: string;
  }>,
  input: Readonly<{ tenantId: string; runId: string; segmentId: string }>,
): RunLifecycleEvent {
  let value: unknown;
  try {
    value = JSON.parse(row.event_json);
  } catch {
    corrupt();
  }
  if (!isRecord(value) || !isRecord(value.identity) || !isRecord(value.data))
    corrupt();
  const event = value as RunLifecycleEvent;
  if (
    Object.keys(value).sort().join(",") !==
      "data,eventId,identity,occurredAt,schemaVersion,sequence,type" ||
    Object.keys(value.identity).join(",") !== "runId" ||
    row.tenant_id !== input.tenantId ||
    row.run_id !== input.runId ||
    event.schemaVersion !== "crewon.run-event.v0" ||
    event.identity.runId !== row.run_id ||
    event.eventId !== row.event_id ||
    typeof event.eventId !== "string" ||
    event.eventId.length === 0 ||
    event.sequence !== row.sequence ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    typeof event.occurredAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(
      event.occurredAt,
    ) ||
    Number.isNaN(Date.parse(event.occurredAt)) ||
    typeof event.type !== "string" ||
    !("segmentId" in event.data) ||
    event.data.segmentId !== input.segmentId ||
    !("segmentSequence" in event.data) ||
    !Number.isSafeInteger(event.data.segmentSequence) ||
    event.data.segmentSequence < 1
  )
    corrupt();
  return event;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadRun(
  database: DatabaseSync,
  tenantId: string,
  runId: string,
): RunState {
  const row = database
    .prepare(
      `SELECT revision,last_sequence,state_json FROM run_snapshots
       WHERE tenant_id=? AND run_id=?`,
    )
    .get(tenantId, runId) as
    | { revision: number; last_sequence: number; state_json: string }
    | undefined;
  if (row === undefined) throw new RunStoreError("run_not_found");
  const run = normalizeStoredRunState(
    JSON.parse(row.state_json) as RunState,
    "stored_run_invalid",
  );
  if (
    run.tenantId !== tenantId ||
    run.runId !== runId ||
    run.revision !== row.revision ||
    run.lastSequence !== row.last_sequence ||
    run.status !== "running" ||
    run.cancelRequested
  )
    corrupt();
  return run;
}

function validateProjectedEvent(
  input: Pick<
    Parameters<typeof appendSqliteWorkflowRetrievedEventSuffix>[1],
    "runId" | "segmentId"
  >,
  segmentSequence: number,
  event: RunLifecycleEvent,
): void {
  if (
    event.schemaVersion !== "crewon.run-event.v0" ||
    event.identity.runId !== input.runId ||
    !("segmentId" in event.data) ||
    event.data.segmentId !== input.segmentId ||
    !("segmentSequence" in event.data) ||
    event.data.segmentSequence !== segmentSequence
  )
    corrupt();
}

function eventSemantics(event: RunLifecycleEvent): string {
  if (!("segmentId" in event.data) || !("segmentSequence" in event.data))
    corrupt();
  return stableJson({ type: event.type, data: event.data });
}

function deterministicId(
  input: Pick<
    Parameters<typeof appendSqliteWorkflowRetrievedEventSuffix>[1],
    "tenantId" | "runId" | "attemptId" | "dispatchOperationId" | "digester"
  >,
  role: "event" | "outbox",
  value: unknown,
): string {
  const digest = input.digester.sha256(
    stableJson({
      schemaVersion: "crewon.workflow-retrieved-event.v0",
      role,
      tenantId: input.tenantId,
      runId: input.runId,
      attemptId: input.attemptId,
      dispatchOperationId: input.dispatchOperationId,
      value,
    }),
  );
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) corrupt();
  return `wf-retrieved:${role}:${digest.slice(7)}`;
}

function insertEvent(
  database: DatabaseSync,
  tenantId: string,
  event: RunLifecycleEvent,
): void {
  database
    .prepare(
      `INSERT INTO run_events(tenant_id,run_id,sequence,event_id,event_json)
       VALUES (?,?,?,?,?)`,
    )
    .run(
      tenantId,
      event.identity.runId,
      event.sequence,
      event.eventId,
      stableJson(event),
    );
}

function insertOutbox(
  database: DatabaseSync,
  input: Parameters<typeof appendSqliteWorkflowRetrievedEventSuffix>[1],
  event: RunLifecycleEvent,
): void {
  const messageId = deterministicId(input, "outbox", event.eventId);
  const message = {
    messageId,
    tenantId: input.tenantId,
    runId: input.runId,
    topic: "run.updated",
    payload: {
      eventId: event.eventId,
      eventType: event.type,
      throughSequence: event.sequence,
    },
    createdAt: input.committedAt,
  };
  database
    .prepare(
      `INSERT INTO outbox(message_id,tenant_id,run_id,topic,message_json,created_at,
       status,available_at_ms,lease_epoch,attempt_count)
       VALUES (?,?,?,?,?,?,'pending',?,0,0)`,
    )
    .run(
      messageId,
      input.tenantId,
      input.runId,
      message.topic,
      stableJson(message),
      input.committedAt,
      Date.parse(input.committedAt),
    );
}

function updateRun(
  database: DatabaseSync,
  current: RunState,
  next: RunState,
  updatedAt: string,
): void {
  const result = database
    .prepare(
      `UPDATE run_snapshots SET revision=?,last_sequence=?,state_json=?,updated_at=?
       WHERE tenant_id=? AND run_id=? AND revision=? AND last_sequence=?`,
    )
    .run(
      next.revision,
      next.lastSequence,
      stableJson(next),
      updatedAt,
      current.tenantId,
      current.runId,
      current.revision,
      current.lastSequence,
    );
  if (result.changes !== 1) throw new RunStoreError("revision_conflict");
}

function corrupt(): never {
  throw new RunStoreError("workflow_retrieved_continuation_corrupt");
}
