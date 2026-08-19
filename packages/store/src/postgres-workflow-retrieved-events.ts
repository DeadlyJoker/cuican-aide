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
  const current = await loadRun(client, schema, input);
  const events: RunLifecycleEvent[] = [];
  const outbox: OutboxMessage[] = [];
  let next = current;
  for (const agentEvent of agentEvents) {
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
  await writePostgresRunSnapshot(
    client,
    schema,
    current,
    next,
    current.revision,
  );
  await writePostgresRunEvents(client, schema, events, input.tenantId);
  await writePostgresOutbox(client, schema, outbox);
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
    run.status !== "running"
  )
    corrupt();
  return run;
}

function corrupt(): never {
  throw new RunStoreError("workflow_retrieved_continuation_corrupt");
}
