import { RunStoreError } from "@crewon/application";
import {
  reduceRunLifecycleEvent,
  type FrozenWorkflowVersionBinding,
  type RunState,
  type WorkflowContentDigester,
} from "@crewon/domain";
import type { PoolClient } from "pg";

import { normalizeStoredRunState } from "./stored-run-state.ts";
import { stableJson } from "./store-invariants.ts";
import { workflowAuthorityId } from "./workflow-run-composition-support.ts";

export type PostgresCanceledWorkflowNode = Readonly<{
  tenantId: string;
  runId: string;
  binding: FrozenWorkflowVersionBinding;
  nodeId: string;
  claimId: string | null;
  claimEpoch: number | null;
  attemptId: string | null;
  operationId: string;
}>;

export type PostgresWorkflowNodeTerminal = PostgresCanceledWorkflowNode &
  Readonly<{
    status: "completed" | "failed" | "canceled";
    resultDigest: string | null;
    failureCode: string | null;
  }>;

export async function appendPostgresCanceledWorkflowNodeEvent(
  client: PoolClient,
  schema: string,
  input: PostgresCanceledWorkflowNode,
  now: string,
  digester: WorkflowContentDigester,
): Promise<void> {
  return appendPostgresWorkflowNodeTerminalEvent(
    client,
    schema,
    {
      ...input,
      status: "canceled",
      resultDigest: null,
      failureCode: null,
    },
    now,
    digester,
  );
}

export async function appendPostgresWorkflowNodeTerminalEvent(
  client: PoolClient,
  schema: string,
  input: PostgresWorkflowNodeTerminal,
  now: string,
  digester: WorkflowContentDigester,
): Promise<void> {
  const run = await client.query<{ state_json: RunState }>(
    `SELECT state_json FROM ${schema}.run_snapshots
     WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
    [input.tenantId, input.runId],
  );
  const current =
    run.rows[0] === undefined
      ? null
      : normalizeStoredRunState(
          run.rows[0].state_json,
          "postgres_run_state_corrupt",
        );
  if (
    current === null ||
    current.purpose !== "workflow" ||
    stableJson(current.workflowVersionBinding) !== stableJson(input.binding)
  )
    throw new RunStoreError("workflow_composition_run_authority_mismatch");
  const authority = terminalAuthority(input);
  const eventId = workflowAuthorityId("run-event", authority, digester);
  const event = {
    schemaVersion: "crewon.run-event.v0" as const,
    identity: { runId: input.runId },
    eventId,
    sequence: current.lastSequence + 1,
    occurredAt: now,
    type: "workflow.node.terminal" as const,
    data: {
      binding: input.binding,
      nodeId: input.nodeId,
      claimId: input.claimId,
      claimEpoch: input.claimEpoch,
      stepId: input.nodeId,
      attemptId: input.attemptId,
      status: input.status,
      resultDigest: input.resultDigest,
      failureCode: input.failureCode,
    },
  };
  const next = reduceRunLifecycleEvent(current, event);
  const updated = await client.query(
    `UPDATE ${schema}.run_snapshots SET revision=$1,last_sequence=$2,state_json=$3,updated_at=$4
     WHERE tenant_id=$5 AND run_id=$6 AND revision=$7`,
    [
      next.revision,
      next.lastSequence,
      next,
      now,
      input.tenantId,
      input.runId,
      current.revision,
    ],
  );
  if (updated.rowCount !== 1) throw new RunStoreError("revision_conflict");
  await client.query(
    `INSERT INTO ${schema}.run_events
     (tenant_id,run_id,sequence,event_id,event_json) VALUES ($1,$2,$3,$4,$5)`,
    [input.tenantId, input.runId, event.sequence, eventId, event],
  );
  const messageId = workflowAuthorityId("run-outbox", authority, digester);
  const message = {
    messageId,
    tenantId: input.tenantId,
    runId: input.runId,
    topic: "run.updated",
    payload: {
      eventId,
      eventType: event.type,
      throughSequence: event.sequence,
    },
    createdAt: now,
  };
  await client.query(
    `INSERT INTO ${schema}.outbox
     (message_id,tenant_id,run_id,topic,message_json,created_at,status,available_at,lease_epoch,attempt_count)
     VALUES ($1,$2,$3,'run.updated',$4,$5,'pending',$5,0,0)`,
    [messageId, input.tenantId, input.runId, message, now],
  );
}

export async function validatePostgresCanceledWorkflowNodeEvent(
  client: PoolClient,
  schema: string,
  input: PostgresCanceledWorkflowNode,
  digester: WorkflowContentDigester,
): Promise<void> {
  const authority = { ...input, lifecycle: "workflow.node.terminal" };
  const eventId = workflowAuthorityId("run-event", authority, digester);
  const messageId = workflowAuthorityId("run-outbox", authority, digester);
  const [event, outbox] = await Promise.all([
    client.query<{ sequence: number | string;
      event_json: Record<string, unknown> }>(
      `SELECT sequence,event_json FROM ${schema}.run_events
       WHERE tenant_id=$1 AND run_id=$2 AND event_id=$3`,
      [input.tenantId, input.runId, eventId],
    ),
    client.query<{ tenant_id: string; run_id: string; topic: string;
      message_json: Record<string, unknown> }>(
      `SELECT tenant_id,run_id,topic,message_json
       FROM ${schema}.outbox WHERE message_id=$1`,
      [messageId],
    ),
  ]);
  const eventRow = event.rows[0];
  const outboxRow = outbox.rows[0];
  const storedEvent = eventRow?.event_json;
  const storedMessage = outboxRow?.message_json;
  const sequence = Number(eventRow?.sequence);
  if (
    event.rows.length !== 1 ||
    outbox.rows.length !== 1 ||
    storedEvent?.schemaVersion !== "crewon.run-event.v0" ||
    (storedEvent.identity as Record<string, unknown> | undefined)?.runId !== input.runId ||
    storedEvent?.eventId !== eventId ||
    storedEvent.sequence !== sequence ||
    storedEvent.type !== "workflow.node.terminal" ||
    stableJson(storedEvent.data) !==
      stableJson({
        binding: input.binding,
        nodeId: input.nodeId,
        claimId: input.claimId,
        claimEpoch: input.claimEpoch,
        stepId: input.nodeId,
        attemptId: input.attemptId,
        status: "canceled",
        resultDigest: null,
        failureCode: null,
      }) ||
    outboxRow?.tenant_id !== input.tenantId ||
    outboxRow.run_id !== input.runId ||
    outboxRow.topic !== "run.updated" ||
    stableJson(storedMessage) !== stableJson({
      messageId, tenantId: input.tenantId, runId: input.runId,
      topic: "run.updated", payload: { eventId,
        eventType: "workflow.node.terminal", throughSequence: sequence },
      createdAt: storedEvent.occurredAt })
  )
    throw new RunStoreError("workflow_cancellation_replay_corrupt");
}

export async function validatePostgresWorkflowNodeTerminalEvent(
  client: PoolClient,
  schema: string,
  input: PostgresWorkflowNodeTerminal,
  digester: WorkflowContentDigester,
): Promise<void> {
  const authority = terminalAuthority(input);
  const eventId = workflowAuthorityId("run-event", authority, digester);
  const messageId = workflowAuthorityId("run-outbox", authority, digester);
  const [event, outbox] = await Promise.all([
    client.query<{ sequence: number | string;
      event_json: Record<string, unknown> }>(
      `SELECT sequence,event_json FROM ${schema}.run_events
       WHERE tenant_id=$1 AND run_id=$2 AND event_id=$3`,
      [input.tenantId, input.runId, eventId],
    ),
    client.query<{ tenant_id: string; run_id: string; topic: string;
      message_json: Record<string, unknown> }>(
      `SELECT tenant_id,run_id,topic,message_json
       FROM ${schema}.outbox WHERE message_id=$1`,
      [messageId],
    ),
  ]);
  const eventRow = event.rows[0];
  const outboxRow = outbox.rows[0];
  const storedEvent = eventRow?.event_json;
  const sequence = Number(eventRow?.sequence);
  const expectedData = {
    binding: input.binding,
    nodeId: input.nodeId,
    claimId: input.claimId,
    claimEpoch: input.claimEpoch,
    stepId: input.nodeId,
    attemptId: input.attemptId,
    status: input.status,
    resultDigest: input.resultDigest,
    failureCode: input.failureCode,
  };
  const expectedMessage = {
    messageId,
    tenantId: input.tenantId,
    runId: input.runId,
    topic: "run.updated",
    payload: {
      eventId,
      eventType: "workflow.node.terminal",
      throughSequence: sequence,
    },
    createdAt: storedEvent?.occurredAt,
  };
  if (
    event.rows.length !== 1 ||
    outbox.rows.length !== 1 ||
    storedEvent?.schemaVersion !== "crewon.run-event.v0" ||
    (storedEvent.identity as Record<string, unknown> | undefined)?.runId !== input.runId ||
    storedEvent.eventId !== eventId ||
    storedEvent.sequence !== sequence ||
    storedEvent.type !== "workflow.node.terminal" ||
    stableJson(storedEvent.data) !== stableJson(expectedData) ||
    outboxRow?.tenant_id !== input.tenantId ||
    outboxRow.run_id !== input.runId ||
    outboxRow.topic !== "run.updated" ||
    stableJson(outboxRow.message_json) !== stableJson(expectedMessage)
  )
    throw new RunStoreError("workflow_node_terminal_lifecycle_corrupt");
}

function terminalAuthority(input: PostgresWorkflowNodeTerminal) {
  const {
    status: _status,
    resultDigest: _resultDigest,
    failureCode: _failureCode,
    ...authority
  } = input;
  return {
    ...authority,
    lifecycle: "workflow.node.terminal",
  };
}
