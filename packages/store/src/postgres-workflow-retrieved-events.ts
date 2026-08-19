import {
  canonicalJson,
  projectWorkflowRetrievedContinuationEvent,
  RunStoreError,
  type OutboxMessage,
  type WorkflowRunCompositionStore,
} from "@crewon/application";
import {
  reduceRunLifecycleEvent,
  type RunLifecycleEvent,
  type RunState,
  type WorkflowContentDigester,
} from "@crewon/domain";
import type { CanonicalAgentEvent } from "@crewon/contracts/runtime";
import type { PoolClient } from "pg";

import {
  writePostgresOutbox,
  writePostgresRunEvents,
  writePostgresRunSnapshot,
} from "./postgres-run-writer.ts";
import { stableJson } from "./store-invariants.ts";
import { normalizeStoredRunState } from "./stored-run-state.ts";
import { workflowAuthorityId } from "./workflow-run-composition-support.ts";
import type { PostgresRunEventRow } from "./postgres-run-codec.ts";

type Input = Parameters<
  WorkflowRunCompositionStore["commitRetrievedWorkflowNodeContinuation"]
>[0];

export async function persistPostgresRetrievedWorkflowEvents(
  client: PoolClient,
  schema: string,
  input: Input,
  agentEvents: readonly CanonicalAgentEvent[],
  occurredAt: string,
  digester: WorkflowContentDigester,
): Promise<void> {
  const existing = await loadSegmentEvents(client, schema, input);
  if (existing.length > agentEvents.length) corrupt();
  const expected = agentEvents.map((event, index) =>
    projectWorkflowRetrievedContinuationEvent(
      event,
      index + 1,
      `retrieved-prefix-${index + 1}`,
      occurredAt,
      (checkpoint) => digester.sha256(canonicalJson(checkpoint)),
    ),
  );
  for (let index = 0; index < existing.length; index += 1) {
    if (eventSemantics(existing[index]!) !== eventSemantics(expected[index]!))
      corrupt();
  }
  const current = await loadRun(client, schema, input);
  const events: RunLifecycleEvent[] = [];
  const outbox: OutboxMessage[] = [];
  let next = current;
  for (let index = existing.length; index < agentEvents.length; index += 1) {
    const agentEvent = agentEvents[index]!;
    const eventId = workflowAuthorityId(
      "run-event",
      {
        tenantId: input.tenantId,
        runId: input.runId,
        nodeId: input.nodeId,
        attemptId: input.attempt.attemptId,
        operationId: input.dispatch.operationId,
        requestSequence: input.dispatch.requestSequence,
        segmentId: agentEvent.segmentId,
        segmentSequence: agentEvent.sequence,
        eventType: agentEvent.type,
      },
      digester,
    );
    const event = projectWorkflowRetrievedContinuationEvent(
      agentEvent,
      next.lastSequence + 1,
      eventId,
      occurredAt,
      (checkpoint) => digester.sha256(canonicalJson(checkpoint)),
    );
    next = reduceRunLifecycleEvent(next, event);
    events.push(event);
    outbox.push({
      messageId: workflowAuthorityId(
        "run-outbox",
        { tenantId: input.tenantId, runId: input.runId, eventId },
        digester,
      ),
      tenantId: input.tenantId,
      runId: input.runId,
      topic: "run.updated",
      payload: {
        eventId,
        eventType: event.type,
        throughSequence: event.sequence,
      },
      createdAt: occurredAt,
    });
  }
  if (events.length > 0) {
    await writePostgresRunSnapshot(
      client,
      schema,
      current,
      next,
      current.revision,
    );
    await writePostgresRunEvents(client, schema, events, input.tenantId);
    await writePostgresOutbox(client, schema, outbox);
  }
  for (const event of agentEvents) {
    await client.query(
      `INSERT INTO ${schema}.workflow_agent_events
       (tenant_id,run_id,node_id,attempt_id,segment_id,sequence,event_type,event_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [
        input.tenantId,
        input.runId,
        input.nodeId,
        input.attempt.attemptId,
        event.segmentId,
        event.sequence,
        event.type,
        stableJson(event),
      ],
    );
  }
}

async function loadSegmentEvents(
  client: PoolClient,
  schema: string,
  input: Pick<Input, "tenantId" | "runId"> &
    Readonly<{ payload: Input["payload"] }>,
): Promise<readonly RunLifecycleEvent[]> {
  const result = await client.query<PostgresRunEventRow>(
    `SELECT tenant_id,run_id,sequence,event_id,event_json
     FROM ${schema}.run_events
     WHERE tenant_id=$1 AND run_id=$2
       AND event_json->'data'->>'segmentId'=$3
     ORDER BY sequence
     FOR UPDATE`,
    [input.tenantId, input.runId, input.payload.next.segmentId],
  );
  return result.rows.map((row) =>
    decodeSegmentEventRow(row, {
      tenantId: input.tenantId,
      runId: input.runId,
      segmentId: input.payload.next.segmentId,
    }),
  );
}

function decodeSegmentEventRow(
  row: PostgresRunEventRow,
  input: Readonly<{ tenantId: string; runId: string; segmentId: string }>,
): RunLifecycleEvent {
  const value = row.event_json;
  if (!isRecord(value) || !isRecord(value.identity) || !isRecord(value.data))
    corrupt();
  const event = value as unknown as RunLifecycleEvent;
  const sequence = Number(row.sequence);
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
    event.sequence !== sequence ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
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

function eventSemantics(event: RunLifecycleEvent): string {
  if (!("segmentId" in event.data) || !("segmentSequence" in event.data))
    corrupt();
  return stableJson({ type: event.type, data: event.data });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadRun(
  client: PoolClient,
  schema: string,
  input: Input,
): Promise<RunState> {
  const result = await client.query<{ state_json: RunState }>(
    `SELECT state_json FROM ${schema}.run_snapshots
     WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
    [input.tenantId, input.runId],
  );
  if (result.rows[0] === undefined) corrupt();
  const run = normalizeStoredRunState(
    result.rows[0].state_json,
    "workflow_retrieved_continuation_corrupt",
  );
  if (
    run.tenantId !== input.tenantId ||
    run.runId !== input.runId ||
    run.purpose !== "workflow" ||
    run.status !== "running" ||
    run.cancelRequested
  )
    corrupt();
  return run;
}

function corrupt(): never {
  throw new RunStoreError("workflow_retrieved_continuation_corrupt");
}
