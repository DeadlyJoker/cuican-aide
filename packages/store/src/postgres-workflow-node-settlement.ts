import {
  canonicalJson,
  RunStoreError,
  type WorkflowRunCompositionStore,
} from "@crewon/application";
import {
  composeWorkflowOutput,
  reduceRunLifecycleEvent,
  validateWorkflowSchemaValue,
  MAX_WORKFLOW_VALUE_BYTES,
  type RunState,
  type WorkflowContentDigester,
} from "@crewon/domain";
import type { PoolClient } from "pg";
import {
  finishPostgresRunAttempt,
  loadPostgresRunAttempt,
  loadPostgresRunStep,
} from "./postgres-execution-authority.ts";
import { stableJson } from "./store-invariants.ts";
import { normalizeStoredRunState } from "./stored-run-state.ts";
import { validateWorkflowExecutionState } from "./workflow-execution-store.ts";
import {
  assertExecutionBinding,
  settleWorkflowClaim,
  workflowAuthorityId,
} from "./workflow-run-composition-support.ts";
import {
  completePostgresWorkflowLease,
  insertPostgresWorkflowReceipt,
  insertPostgresWorkflowWorkItem,
  loadPostgresWorkflowAuthorities,
  loadPostgresWorkflowExecution,
  loadPostgresWorkflowReceipt,
  loadPostgresWorkflowValue,
  postgresWorkflowFingerprint,
  validatePostgresWorkflowLease,
  writePostgresWorkflowExecution,
} from "./postgres-workflow-run-composition-transactions.ts";
type Input = Parameters<WorkflowRunCompositionStore["settleWorkflowNode"]>[0];
type Result = Awaited<
  ReturnType<WorkflowRunCompositionStore["settleWorkflowNode"]>
>;
export async function settlePostgresWorkflowNode(
  client: PoolClient,
  schema: string,
  input: Input,
  digester: WorkflowContentDigester,
  model?: Readonly<{ fingerprintAuthority: unknown; agentVersionId: string }>,
): Promise<Result> {
  const fingerprint = postgresWorkflowFingerprint(
    "settleNode",
    model?.fingerprintAuthority ?? input,
    digester,
  );
  const replay = await loadPostgresWorkflowReceipt(
    client,
    schema,
    input,
    "settleNode",
    fingerprint,
  );
  if (replay !== null)
    return validateReplay(client, schema, input, replay, digester);
  const now = await validatePostgresWorkflowLease(client, schema, input);
  const workflow = await loadPostgresWorkflowAuthorities(
    client,
    schema,
    input,
    digester,
  );
  const execution = await loadPostgresWorkflowExecution(
    client,
    schema,
    input,
    true,
  );
  const step = await loadPostgresRunStep(client, schema, input, true);
  const attempt = await loadPostgresRunAttempt(client, schema, input, true);
  if (
    execution === null ||
    step === null ||
    attempt === null ||
    input.stepId !== input.nodeId ||
    step.currentAttemptId !== input.attemptId ||
    attempt.workItemId !== input.lease.workItemId ||
    attempt.leaseEpoch !== input.lease.leaseEpoch ||
    attempt.status !== "running"
  )
    throw new RunStoreError("workflow_composition_attempt_mismatch");
  const definition = workflow.nodes.find(
    (node) => node.nodeId === input.nodeId,
  );
  if (definition === undefined)
    throw new RunStoreError("workflow_composition_claim_mismatch");
  const node = execution.nodes.find(
    (candidate) => candidate.nodeId === input.nodeId,
  );
  const expectedKind =
    definition.kind === "verification" ? "verification" : "agent";
  if (
    node === undefined ||
    definition.kind === "humanGate" ||
    step.kind !== expectedKind ||
    step.status !== "running" ||
    node.status !== "running" ||
    node.claimId !== input.claimId ||
    node.claimEpoch !== input.claimEpoch ||
    (model !== undefined && node.agentVersionId !== model.agentVersionId) ||
    attempt.tenantId !== input.tenantId ||
    attempt.runId !== input.runId ||
    attempt.stepId !== input.stepId
  )
    throw new RunStoreError("workflow_composition_attempt_mismatch");
  let resultDigest: string | undefined;
  if (input.outcome.status === "completed") {
    const value = validateWorkflowSchemaValue(
      input.outcome.value,
      definition.outputSchema,
    );
    const valueJson = canonicalJson(value);
    if (
      new TextEncoder().encode(valueJson).byteLength > MAX_WORKFLOW_VALUE_BYTES
    )
      throw new RunStoreError("workflow_execution_value_invalid");
    resultDigest = digester.sha256(valueJson);
    await insertValue(
      client,
      schema,
      input,
      "nodeOutput",
      input.nodeId,
      workflowAuthorityId(
        "value",
        {
          tenantId: input.tenantId,
          runId: input.runId,
          nodeId: input.nodeId,
          claimId: input.claimId,
          claimEpoch: input.claimEpoch,
          resultDigest,
        },
        digester,
      ),
      resultDigest,
      value,
      now,
    );
  }
  const next = settleWorkflowClaim({ execution, ...input, resultDigest, now });
  if (input.outcome.status !== "unknown")
    await finishPostgresRunAttempt(client, schema, {
      tenantId: input.tenantId,
      runId: input.runId,
      workItemId: input.lease.workItemId,
      leaseEpoch: input.lease.leaseEpoch,
      attempt: terminalAttempt(input, now),
    });
  await writePostgresWorkflowExecution(client, schema, next, now);
  const runDisposition = await convergePostgresWorkflowRun(
    client,
    schema,
    input,
    workflow,
    next,
    now,
    digester,
  );
  let nextWorkItemId: string | null = null;
  let kind: "none" | "scheduler" | "reconcile" = "none";
  if (input.outcome.status === "unknown") {
    kind = "reconcile";
    nextWorkItemId = workflowAuthorityId(
      "reconcile",
      {
        tenantId: input.tenantId,
        runId: input.runId,
        binding: input.binding,
        operationId: input.operationId,
        nodeId: input.nodeId,
        claimId: input.claimId,
        claimEpoch: input.claimEpoch,
      },
      digester,
    );
    await insertPostgresWorkflowWorkItem(
      client,
      schema,
      nextWorkItemId,
      input,
      {
        schemaVersion: "crewon.workflow-reconcile-work-item.v0",
        trigger: "workflowReconcile",
        binding: input.binding,
        nodeId: input.nodeId,
        claimId: input.claimId,
        claimEpoch: input.claimEpoch,
        reconciliationOperationId: input.operationId,
      },
      now,
    );
  } else if (
    next.status === "running" &&
    !next.nodes.some((node) =>
      ["queued", "running", "unknown", "waitingHuman"].includes(node.status),
    )
  ) {
    kind = "scheduler";
    nextWorkItemId = workflowAuthorityId(
      "scheduler",
      {
        tenantId: input.tenantId,
        runId: input.runId,
        binding: input.binding,
        settledNodeId: input.nodeId,
        claimId: input.claimId,
        claimEpoch: input.claimEpoch,
      },
      digester,
    );
    const root = await loadPostgresWorkflowValue(
      client,
      schema,
      input,
      "rootInput",
      null,
      digester,
    );
    if (root === null)
      throw new RunStoreError("workflow_execution_value_not_found");
    await insertPostgresWorkflowWorkItem(
      client,
      schema,
      nextWorkItemId,
      input,
      {
        schemaVersion: "crewon.workflow-scheduler-work-item.v1",
        trigger: "workflowScheduler",
        binding: input.binding,
        schedulerOperationId: nextWorkItemId,
        workflowInput: { valueId: root.valueId, valueDigest: root.valueDigest },
      },
      now,
    );
  }
  const result = {
    disposition:
      input.outcome.status === "unknown"
        ? ("reconciliationScheduled" as const)
        : ("settled" as const),
    execution: next,
    schedulerContinuationWorkItemId:
      kind === "scheduler" ? nextWorkItemId : null,
    handoff: { currentWorkItem: "completed" as const, nextWorkItemId, kind },
    runDisposition,
  };
  await insertPostgresWorkflowReceipt(
    client,
    schema,
    input,
    "settleNode",
    fingerprint,
    result,
  );
  await completePostgresWorkflowLease(client, schema, input, now);
  return structuredClone(result);
}
async function validateReplay(
  client: PoolClient,
  schema: string,
  input: Input,
  stored: unknown,
  digester: WorkflowContentDigester,
): Promise<Result> {
  const result = stored as Result;
  const workflow = await loadPostgresWorkflowAuthorities(
    client,
    schema,
    input,
    digester,
  );
  validateWorkflowExecutionState(result.execution);
  assertExecutionBinding(
    result.execution,
    input.tenantId,
    input.runId,
    input.binding,
    workflow,
  );
  const current = await loadPostgresWorkflowExecution(
    client,
    schema,
    input,
    true,
  );
  const step = await loadPostgresRunStep(client, schema, input, true);
  const attempt = await loadPostgresRunAttempt(client, schema, input, true);
  if (
    current === null ||
    current.revision < result.execution.revision ||
    step === null ||
    attempt === null ||
    attempt.attemptId !== input.attemptId ||
    (input.outcome.status !== "unknown" &&
      attempt.status !== input.outcome.status) ||
    result.handoff?.currentWorkItem !== "completed"
  )
    replayCorrupt();
  await validateCompletedWork(client, schema, input);
  await validateReplayHandoff(client, schema, input, result, digester);
  if (input.outcome.status === "completed") {
    const value = await loadPostgresWorkflowValue(
      client,
      schema,
      input,
      "nodeOutput",
      input.nodeId,
      digester,
    );
    if (
      value === null ||
      value.valueDigest !==
        result.execution.nodes.find((node) => node.nodeId === input.nodeId)
          ?.resultDigest
    )
      replayCorrupt();
  }
  if (result.runDisposition === "terminalConverged")
    await validatePostgresTerminalWorkflowRun(
      client,
      schema,
      input,
      result,
      digester,
    );
  return { ...structuredClone(result), disposition: "replay" };
}
export async function convergePostgresWorkflowRun(
  client: PoolClient,
  schema: string,
  input: Input,
  workflow: import("@crewon/domain").CompiledWorkflowVersion,
  execution: import("@crewon/application").WorkflowExecutionState,
  now: string,
  digester: WorkflowContentDigester,
): Promise<"nonTerminal" | "terminalConverged"> {
  if (
    !(["completed", "failed", "canceled"] as string[]).includes(
      execution.status,
    )
  )
    return "nonTerminal";
  const row = await client.query<{ state_json: RunState }>(
    `SELECT state_json FROM ${schema}.run_snapshots WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
    [input.tenantId, input.runId],
  );
  const current =
    row.rows[0] === undefined
      ? null
      : normalizeStoredRunState(
          row.rows[0].state_json,
          "postgres_run_state_corrupt",
        );
  if (current === null || current.goalBinding !== null)
    throw new RunStoreError("workflow_composition_run_authority_mismatch");
  let outputRef: string | null = null;
  if (execution.status === "completed") {
    const outputValues = [];
    for (const nodeId of workflow.outputNodeIds) {
      const output = await loadPostgresWorkflowValue(
        client,
        schema,
        input,
        "nodeOutput",
        nodeId,
        digester,
      );
      if (output === null)
        throw new RunStoreError("workflow_execution_value_not_found");
      outputValues.push({ nodeId, value: output.value });
    }
    const value = validateWorkflowSchemaValue(
      composeWorkflowOutput({ workflow, outputValues }),
      workflow.outputSchema,
    );
    const valueJson = canonicalJson(value);
    if (
      new TextEncoder().encode(valueJson).byteLength > MAX_WORKFLOW_VALUE_BYTES
    )
      throw new RunStoreError("workflow_execution_value_invalid");
    const digest = digester.sha256(valueJson);
    outputRef = workflowAuthorityId(
      "value",
      {
        tenantId: input.tenantId,
        runId: input.runId,
        role: "workflowOutput",
        valueDigest: digest,
      },
      digester,
    );
    await insertValue(
      client,
      schema,
      input,
      "workflowOutput",
      null,
      outputRef,
      digest,
      value,
      now,
    );
  }
  const eventId = workflowAuthorityId("run-event", input, digester);
  const event = {
    schemaVersion: "crewon.run-event.v0" as const,
    identity: { runId: input.runId },
    eventId,
    sequence: current.lastSequence + 1,
    occurredAt: now,
    ...(execution.status === "completed"
      ? { type: "run.completed" as const, data: { outputRef } }
      : execution.status === "failed"
        ? {
            type: "run.failed" as const,
            data: { code: "workflow_node_failed", retryable: false },
          }
        : {
            type: "run.canceled" as const,
            data: { reasonCode: "workflow_canceled" },
          }),
  };
  const next = reduceRunLifecycleEvent(current, event);
  const updated = await client.query(
    `UPDATE ${schema}.run_snapshots SET revision=$1,
    last_sequence=$2,state_json=$3,updated_at=$4 WHERE tenant_id=$5 AND run_id=$6 AND revision=$7`,
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
  const messageId = workflowAuthorityId("run-outbox", input, digester);
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
  return "terminalConverged";
}
export async function validatePostgresTerminalWorkflowRun(
  client: PoolClient,
  schema: string,
  input: Input,
  result: Result,
  digester: WorkflowContentDigester,
) {
  const run = await client.query<{
    last_sequence: number | string;
    state_json: RunState;
  }>(
    `SELECT last_sequence,state_json FROM ${schema}.run_snapshots WHERE tenant_id=$1 AND run_id=$2`,
    [input.tenantId, input.runId],
  );
  const eventId = workflowAuthorityId("run-event", input, digester);
  const messageId = workflowAuthorityId("run-outbox", input, digester);
  const event = await client.query<{
    tenant_id: string;
    run_id: string;
    sequence: number | string;
    event_id: string;
    event_json: Record<string, unknown>;
  }>(
    `SELECT tenant_id,run_id,
    sequence,event_id,event_json FROM ${schema}.run_events
    WHERE tenant_id=$1 AND run_id=$2 AND event_id=$3`,
    [input.tenantId, input.runId, eventId],
  );
  const outbox = await client.query<{
    tenant_id: string;
    run_id: string;
    topic: string;
    message_json: Record<string, unknown>;
  }>(
    `SELECT tenant_id,run_id,topic,message_json
    FROM ${schema}.outbox WHERE tenant_id=$1 AND run_id=$2 AND message_id=$3`,
    [input.tenantId, input.runId, messageId],
  );
  const runState = run.rows[0]?.state_json;
  const eventRow = event.rows[0];
  const outboxRow = outbox.rows[0];
  const expectedType =
    result.execution.status === "completed"
      ? "run.completed"
      : result.execution.status === "failed"
        ? "run.failed"
        : "run.canceled";
  if (
    runState?.status !== result.execution.status ||
    eventRow === undefined ||
    outboxRow === undefined ||
    Number(run.rows[0]!.last_sequence) !== Number(eventRow.sequence) ||
    eventRow.tenant_id !== input.tenantId ||
    eventRow.run_id !== input.runId ||
    eventRow.event_id !== eventId ||
    eventRow.event_json.eventId !== eventId ||
    eventRow.event_json.sequence !== Number(eventRow.sequence) ||
    eventRow.event_json.type !== expectedType ||
    outboxRow.tenant_id !== input.tenantId ||
    outboxRow.run_id !== input.runId ||
    outboxRow.topic !== "run.updated" ||
    outboxRow.message_json.messageId !== messageId ||
    outboxRow.message_json.topic !== "run.updated" ||
    (outboxRow.message_json.payload as Record<string, unknown> | undefined)
      ?.eventId !== eventId ||
    (outboxRow.message_json.payload as Record<string, unknown> | undefined)
      ?.throughSequence !== Number(eventRow.sequence) ||
    runState.outputRef !==
      (result.execution.status === "completed"
        ? (eventRow.event_json.data as Record<string, unknown> | undefined)
            ?.outputRef
        : null)
  )
    replayCorrupt();
}

async function validateCompletedWork(
  client: PoolClient,
  schema: string,
  input: Input,
) {
  const work = await client.query<{
    tenant_id: string;
    run_id: string;
    status: string;
    lease_owner_id: string | null;
    lease_id: string | null;
    lease_epoch: number | string;
    lease_expires_at: unknown;
    completed_at: unknown;
  }>(
    `SELECT tenant_id,run_id,status,
    lease_owner_id,lease_id,lease_epoch,lease_expires_at,completed_at
    FROM ${schema}.work_items WHERE work_item_id=$1 FOR UPDATE`,
    [input.lease.workItemId],
  );
  const row = work.rows[0];
  if (
    row === undefined ||
    row.tenant_id !== input.tenantId ||
    row.run_id !== input.runId ||
    row.status !== "completed" ||
    Number(row.lease_epoch) !== input.lease.leaseEpoch ||
    row.lease_owner_id !== null ||
    row.lease_id !== null ||
    row.lease_expires_at !== null ||
    row.completed_at === null
  )
    replayCorrupt();
}

async function validateReplayHandoff(
  client: PoolClient,
  schema: string,
  input: Input,
  result: Result,
  digester: WorkflowContentDigester,
) {
  const kind =
    input.outcome.status === "unknown"
      ? "reconcile"
      : result.schedulerContinuationWorkItemId === null
        ? "none"
        : "scheduler";
  if (
    result.handoff.kind !== kind ||
    (kind === "scheduler" &&
      result.handoff.nextWorkItemId !==
        result.schedulerContinuationWorkItemId) ||
    (kind === "none" && result.handoff.nextWorkItemId !== null)
  )
    replayCorrupt();
  if (kind === "none") return;
  const expectedId =
    kind === "reconcile"
      ? workflowAuthorityId(
          "reconcile",
          {
            tenantId: input.tenantId,
            runId: input.runId,
            binding: input.binding,
            operationId: input.operationId,
            nodeId: input.nodeId,
            claimId: input.claimId,
            claimEpoch: input.claimEpoch,
          },
          digester,
        )
      : workflowAuthorityId(
          "scheduler",
          {
            tenantId: input.tenantId,
            runId: input.runId,
            binding: input.binding,
            settledNodeId: input.nodeId,
            claimId: input.claimId,
            claimEpoch: input.claimEpoch,
          },
          digester,
        );
  const work = await client.query<{
    tenant_id: string;
    run_id: string;
    status: string;
    work_item_json: { payload?: unknown };
  }>(
    `SELECT tenant_id,run_id,status,work_item_json
    FROM ${schema}.work_items WHERE work_item_id=$1`,
    [expectedId],
  );
  const row = work.rows[0];
  if (
    result.handoff.nextWorkItemId !== expectedId ||
    row === undefined ||
    row.tenant_id !== input.tenantId ||
    row.run_id !== input.runId ||
    row.status !== "pending"
  )
    replayCorrupt();
  const payload =
    kind === "reconcile"
      ? {
          schemaVersion: "crewon.workflow-reconcile-work-item.v0",
          trigger: "workflowReconcile",
          binding: input.binding,
          nodeId: input.nodeId,
          claimId: input.claimId,
          claimEpoch: input.claimEpoch,
          reconciliationOperationId: input.operationId,
        }
      : row.work_item_json.payload;
  if (
    kind === "reconcile" &&
    stableJson(row.work_item_json.payload) !== stableJson(payload)
  )
    replayCorrupt();
  if (
    kind === "scheduler" &&
    (row.work_item_json.payload as { schedulerOperationId?: unknown })
      ?.schedulerOperationId !== expectedId
  )
    replayCorrupt();
}
async function insertValue(
  client: PoolClient,
  schema: string,
  input: { tenantId: string; runId: string },
  role: string,
  nodeId: string | null,
  valueId: string,
  digest: string,
  value: unknown,
  now: string,
) {
  await client.query(
    `INSERT INTO ${schema}.workflow_execution_values
    (tenant_id,run_id,value_id,role,node_id,value_digest,value_json,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [input.tenantId, input.runId, valueId, role, nodeId, digest, value, now],
  );
}
function terminalAttempt(input: Input, now: string) {
  const common = {
    stepId: input.stepId,
    attemptId: input.attemptId,
    finishedAt: now,
    checkpointDigest: null,
  };
  if (
    input.outcome.status === "completed" ||
    input.outcome.status === "canceled"
  )
    return { ...common, status: input.outcome.status };
  if (input.outcome.status === "failed")
    return {
      ...common,
      status: "failed" as const,
      failure: { code: input.outcome.failureCode, retryable: false },
    };
  throw new RunStoreError("workflow_composition_unknown_not_terminal");
}
function replayCorrupt(): never {
  throw new RunStoreError("workflow_composition_receipt_corrupt");
}
