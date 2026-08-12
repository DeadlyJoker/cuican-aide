import {
  RunStoreError,
  type WorkflowRunCompositionStore,
} from "@crewon/application";
import type { WorkflowContentDigester } from "@crewon/domain";
import type { PoolClient } from "pg";

import { loadPostgresRunStep } from "./postgres-execution-authority.ts";
import {
  convergePostgresWorkflowRun,
  validatePostgresTerminalWorkflowRun,
} from "./postgres-workflow-node-settlement.ts";
import { stableJson } from "./store-invariants.ts";
import {
  completePostgresWorkflowLease,
  insertPostgresWorkflowReceipt,
  loadPostgresWorkflowAuthorities,
  loadPostgresWorkflowExecution,
  loadPostgresWorkflowReceipt,
  postgresWorkflowFingerprint,
  validatePostgresWorkflowLease,
  writePostgresWorkflowExecution,
} from "./postgres-workflow-run-composition-transactions.ts";

type Input = Parameters<
  WorkflowRunCompositionStore["cancelWorkflowExecution"]
>[0];
type Result = Awaited<
  ReturnType<WorkflowRunCompositionStore["cancelWorkflowExecution"]>
>;

export async function cancelPostgresWorkflowExecution(
  client: PoolClient,
  schema: string,
  input: Input,
  digester: WorkflowContentDigester,
): Promise<Result> {
  const fingerprint = postgresWorkflowFingerprint(
    "cancelExecution",
    input,
    digester,
  );
  const replay = await loadPostgresWorkflowReceipt(
    client,
    schema,
    input,
    "cancelExecution",
    fingerprint,
  );
  if (replay !== null)
    return validateReplay(client, schema, input, replay as Result, digester);
  const now = await validatePostgresWorkflowLease(client, schema, input);
  const workflow = await loadPostgresWorkflowAuthorities(
    client,
    schema,
    input,
    digester,
  );
  const run = await client.query<{ state_json: { cancelRequested?: unknown } }>(
    `SELECT state_json FROM ${schema}.run_snapshots
     WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
    [input.tenantId, input.runId],
  );
  if (run.rows[0]?.state_json.cancelRequested !== true)
    throw new RunStoreError("workflow_cancellation_not_requested");
  const execution = await loadPostgresWorkflowExecution(
    client,
    schema,
    input,
    true,
  );
  if (execution === null)
    throw new RunStoreError("workflow_execution_not_found");
  if (
    execution.nodes.some(
      (node) => node.status === "running" || node.status === "unknown",
    )
  )
    throw new RunStoreError("workflow_cancellation_reconciliation_required");
  const nodes = [];
  for (const node of execution.nodes) {
    if (node.status === "pending") {
      await insertCanceledStep(
        client,
        schema,
        input,
        node.nodeId,
        node.kind,
        now,
      );
      nodes.push({ ...node, status: "canceled" as const });
    } else if (node.status === "queued") {
      await cancelQueuedNode(client, schema, input, node, now);
      nodes.push({ ...node, status: "canceled" as const });
    } else if (node.status === "waitingHuman") {
      await cancelGate(client, schema, input, node.nodeId, now);
      nodes.push({ ...node, status: "canceled" as const });
    } else {
      nodes.push(node);
    }
  }
  const next = {
    ...execution,
    revision: execution.revision + 1,
    cancelRequested: true,
    nodes,
    status: "canceled" as const,
    updatedAt: now,
  };
  await writePostgresWorkflowExecution(client, schema, next, now);
  const runDisposition = await convergePostgresWorkflowRun(
    client,
    schema,
    input as never,
    workflow,
    next,
    now,
    digester,
  );
  const result = {
    disposition: "canceled" as const,
    execution: next,
    handoff: {
      currentWorkItem: "completed" as const,
      nextWorkItemId: null,
      kind: "none" as const,
    },
    runDisposition,
  };
  await insertPostgresWorkflowReceipt(
    client,
    schema,
    input,
    "cancelExecution",
    fingerprint,
    result,
  );
  await completePostgresWorkflowLease(client, schema, input, now);
  return structuredClone(result);
}

async function cancelQueuedNode(
  client: PoolClient,
  schema: string,
  input: Input,
  node: Readonly<{
    nodeId: string;
    kind: "agent" | "verification" | "humanGate";
    claimId: string | null;
    claimEpoch: number;
    claimOperationId: string | null;
  }>,
  now: string,
) {
  const expectedPayload = {
    schemaVersion: "crewon.workflow-node-work-item.v0",
    trigger: "workflowNode",
    binding: input.binding,
    nodeId: node.nodeId,
    claimId: node.claimId,
    claimEpoch: node.claimEpoch,
    schedulerOperationId: node.claimOperationId,
  };
  const work = await client.query<{
    work_item_id: string;
    status: string;
    work_item_json: { payload?: unknown };
  }>(
    `SELECT work_item_id,status,work_item_json FROM ${schema}.work_items
     WHERE tenant_id=$1 AND run_id=$2
       AND work_item_json->'payload'->>'trigger'='workflowNode'
       AND work_item_json->'payload'->>'nodeId'=$3 FOR UPDATE`,
    [input.tenantId, input.runId, node.nodeId],
  );
  const row = work.rows[0];
  if (
    work.rows.length !== 1 ||
    row?.status !== "pending" ||
    stableJson(row.work_item_json.payload) !== stableJson(expectedPayload)
  )
    throw new RunStoreError("workflow_cancellation_reconciliation_required");
  const updated = await client.query(
    `UPDATE ${schema}.work_items SET status='completed',completed_at=$1
     WHERE work_item_id=$2 AND status='pending'`,
    [now, row.work_item_id],
  );
  if (updated.rowCount !== 1)
    throw new RunStoreError("workflow_cancellation_reconciliation_required");
  await insertCanceledStep(client, schema, input, node.nodeId, node.kind, now);
}

async function cancelGate(
  client: PoolClient,
  schema: string,
  input: Input,
  nodeId: string,
  now: string,
) {
  const gate = await client.query(
    `UPDATE ${schema}.workflow_gate_requests SET status='canceled',updated_at=$1
     WHERE tenant_id=$2 AND run_id=$3 AND node_id=$4 AND status='published'`,
    [now, input.tenantId, input.runId, nodeId],
  );
  const step = await loadPostgresRunStep(
    client,
    schema,
    { tenantId: input.tenantId, runId: input.runId, stepId: nodeId },
    true,
  );
  if (
    gate.rowCount !== 1 ||
    step?.kind !== "gate" ||
    step.status !== "waitingApproval"
  )
    throw new RunStoreError("workflow_composition_gate_mismatch");
  const terminal = {
    ...step,
    status: "canceled" as const,
    revision: step.revision + 1,
    updatedAt: now,
    terminalAt: now,
  };
  const updated = await client.query(
    `UPDATE ${schema}.run_steps SET status='canceled',revision=$1,state_json=$2,
     updated_at=$3,terminal_at=$3 WHERE tenant_id=$4 AND run_id=$5
       AND step_id=$6 AND revision=$7`,
    [
      terminal.revision,
      terminal,
      now,
      input.tenantId,
      input.runId,
      nodeId,
      step.revision,
    ],
  );
  if (updated.rowCount !== 1) throw new RunStoreError("revision_conflict");
}

async function insertCanceledStep(
  client: PoolClient,
  schema: string,
  input: Input,
  nodeId: string,
  nodeKind: "agent" | "verification" | "humanGate",
  now: string,
) {
  const step = {
    tenantId: input.tenantId,
    runId: input.runId,
    stepId: nodeId,
    kind: nodeKind === "humanGate" ? ("gate" as const) : nodeKind,
    status: "canceled" as const,
    revision: 1,
    currentAttemptId: null,
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
    terminalAt: now,
  };
  await client.query(
    `INSERT INTO ${schema}.run_steps
     (tenant_id,run_id,step_id,kind,status,revision,current_attempt_id,attempt_count,
      state_json,created_at,updated_at,terminal_at)
     VALUES ($1,$2,$3,$4,'canceled',1,NULL,0,$5,$6,$6,$6)`,
    [input.tenantId, input.runId, nodeId, step.kind, step, now],
  );
}

async function validateReplay(
  client: PoolClient,
  schema: string,
  input: Input,
  result: Result,
  digester: WorkflowContentDigester,
): Promise<Result> {
  if (
    result.runDisposition !== "terminalConverged" ||
    result.execution.status !== "canceled" ||
    result.handoff.currentWorkItem !== "completed" ||
    result.handoff.nextWorkItemId !== null ||
    result.handoff.kind !== "none"
  )
    throw new RunStoreError("workflow_composition_receipt_corrupt");
  const current = await loadPostgresWorkflowExecution(
    client,
    schema,
    input,
    true,
  );
  if (
    current === null ||
    stableJson(current.nodes) !== stableJson(result.execution.nodes)
  )
    throw new RunStoreError("workflow_composition_receipt_corrupt");
  await validatePostgresTerminalWorkflowRun(
    client,
    schema,
    input as never,
    result as never,
    digester,
  );
  return { ...structuredClone(result), disposition: "replay" };
}
