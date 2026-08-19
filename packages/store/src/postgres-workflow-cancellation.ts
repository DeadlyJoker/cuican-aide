import {
  RunStoreError,
  type WorkflowRunCompositionStore,
} from "@crewon/application";
import type { WorkflowContentDigester } from "@crewon/domain";
import type { PoolClient } from "pg";

import {
  finishPostgresRunAttempt,
  loadPostgresRunAttempt,
  loadPostgresRunStep,
} from "./postgres-execution-authority.ts";
import {
  loadPostgresModelDispatchReceipt,
  terminatePostgresModelDispatchForAttempt,
} from "./postgres-model-dispatch-evidence.ts";
import {
  convergePostgresWorkflowRun,
  validatePostgresTerminalWorkflowRun,
} from "./postgres-workflow-node-settlement.ts";
import {
  appendPostgresCanceledWorkflowNodeEvent,
  validatePostgresCanceledWorkflowNodeEvent,
} from "./postgres-workflow-cancellation-lifecycle.ts";
import { stableJson } from "./store-invariants.ts";
import { workflowAuthorityId } from "./workflow-run-composition-support.ts";
import {
  completePostgresWorkflowLease,
  insertPostgresWorkflowReceipt,
  insertPostgresWorkflowWorkItem,
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
  let execution = await loadPostgresWorkflowExecution(
    client,
    schema,
    input,
    true,
  );
  if (execution === null)
    throw new RunStoreError("workflow_execution_not_found");
  const currentWork = await client.query<{ work_item_json: {
    payload?: Record<string, unknown> } }>(
      `SELECT work_item_json FROM ${schema}.work_items WHERE work_item_id=$1`,
      [input.lease.workItemId]);
  const payload = currentWork.rows[0]?.work_item_json.payload;
  if (stableJson(payload?.binding) !== stableJson(input.binding))
    throw new RunStoreError("workflow_composition_work_item_mismatch");
  if (payload?.trigger === "workflowNode") {
    const node = execution.nodes.find((candidate) => candidate.nodeId === payload.nodeId);
    if (node === undefined || node.claimId !== payload.claimId ||
        node.claimEpoch !== payload.claimEpoch)
      throw new RunStoreError("workflow_composition_work_item_mismatch");
    if (node.status !== "running")
      throw new RunStoreError("workflow_cancellation_reconciliation_required");
    const canceled = await cancelRunningNode(
      client, schema, input, execution, node, now, digester);
    execution = canceled.execution;
    const canceledNodeIds = canceled.reconciliationWorkItemId === null
      ? [node.nodeId] : [];
    const reconciliationWorkItemIds = canceled.reconciliationWorkItemId === null
      ? [] : [canceled.reconciliationWorkItemId];
    const result = { disposition: canceled.reconciliationWorkItemId === null
        ? "cancellationPending" as const : "reconciliationScheduled" as const,
      canceledNodeIds, canceledGateRequestNodeIds: [], reconciliationWorkItemIds,
      execution: projectCancellationStatus(execution),
      handoff: { currentWorkItem: "completed" as const,
        nextWorkItemId: canceled.reconciliationWorkItemId,
        kind: canceled.reconciliationWorkItemId === null
          ? "none" as const : "reconcile" as const }, runDisposition: "nonTerminal" as const };
    await writePostgresWorkflowExecution(client, schema, result.execution, now);
    await insertPostgresWorkflowReceipt(
      client, schema, input, "cancelExecution", fingerprint, result);
    await completePostgresWorkflowLease(client, schema, input, now);
    return structuredClone(result);
  }
  if (payload?.trigger !== "workflowCancel")
    throw new RunStoreError("workflow_composition_work_item_mismatch");
  const canceledNodeIds: string[] = [];
  const canceledGateRequestNodeIds: string[] = [];
  const nodes = [];
  for (const node of execution.nodes) {
    if (node.status === "pending") {
      await insertPostgresCanceledWorkflowStep(
        client,
        schema,
        input,
        node.nodeId,
        node.kind,
        now,
      );
      await appendPostgresCanceledWorkflowNodeEvent(client, schema, {
        ...input, nodeId: node.nodeId, claimId: null, claimEpoch: null,
        attemptId: null, operationId: `${input.operationId}:${node.nodeId}`,
      }, now, digester);
      canceledNodeIds.push(node.nodeId);
      nodes.push({ ...node, status: "canceled" as const });
    } else if (node.status === "queued") {
      if (await cancelQueuedNode(client, schema, input, node, now)) {
        await appendPostgresCanceledWorkflowNodeEvent(client, schema, {
          ...input, nodeId: node.nodeId, claimId: node.claimId,
          claimEpoch: node.claimEpoch, attemptId: null,
          operationId: `${input.operationId}:${node.nodeId}`,
        }, now, digester);
        canceledNodeIds.push(node.nodeId);
        nodes.push({ ...node, status: "canceled" as const });
      } else {
        nodes.push(node);
      }
    } else if (node.status === "waitingHuman") {
      await cancelGate(client, schema, input, node.nodeId, now);
      await appendPostgresCanceledWorkflowNodeEvent(client, schema, {
        ...input, nodeId: node.nodeId, claimId: node.claimId,
        claimEpoch: node.claimEpoch, attemptId: null,
        operationId: `${input.operationId}:${node.nodeId}`,
      }, now, digester);
      canceledNodeIds.push(node.nodeId);
      canceledGateRequestNodeIds.push(node.nodeId);
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
    status: "running" as const,
    updatedAt: now,
  };
  const projected = projectCancellationStatus(next);
  await writePostgresWorkflowExecution(client, schema, projected, now);
  const reconciliationWorkItemIds = await ensureCancellationReconciliationWorkItems(
    client, schema, input, projected, workflow.executionOrder, now, digester);
  canceledNodeIds.sort();
  canceledGateRequestNodeIds.sort();
  const active = projected.nodes.some((node) =>
    ["queued", "running", "unknown", "waitingHuman"].includes(node.status));
  if (active) return structuredClone({ disposition: "retryRequired" as const,
    canceledNodeIds, canceledGateRequestNodeIds, reconciliationWorkItemIds,
    execution: projected, handoff: { currentWorkItem: "retained" as const,
      nextWorkItemId: null, kind: "none" as const }, runDisposition: "nonTerminal" as const });
  const reconciliationWorkItemId = reconciliationWorkItemIds[0] ?? null;
  const runDisposition = await convergePostgresWorkflowRun(
    client, schema, input as never, workflow, projected, now, digester);
  const result = {
    disposition:
      reconciliationWorkItemId === null
        ? ("canceled" as const)
        : ("reconciliationScheduled" as const),
    canceledNodeIds, canceledGateRequestNodeIds, reconciliationWorkItemIds,
    execution: projected,
    handoff: {
      currentWorkItem: "completed" as const,
      nextWorkItemId: reconciliationWorkItemId,
      kind:
        reconciliationWorkItemId === null
          ? ("none" as const)
          : ("reconcile" as const),
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

async function cancelRunningNode(
  client: PoolClient,
  schema: string,
  input: Input,
  execution: NonNullable<
    Awaited<ReturnType<typeof loadPostgresWorkflowExecution>>
  >,
  node: NonNullable<
    Awaited<ReturnType<typeof loadPostgresWorkflowExecution>>
  >["nodes"][number],
  now: string,
  digester: WorkflowContentDigester,
) {
  const step = await loadPostgresRunStep(
    client,
    schema,
    { tenantId: input.tenantId, runId: input.runId, stepId: node.nodeId },
    true,
  );
  const attempt =
    step?.currentAttemptId === null || step === null
      ? null
      : await loadPostgresRunAttempt(
          client,
          schema,
          {
            tenantId: input.tenantId,
            runId: input.runId,
            stepId: node.nodeId,
            attemptId: step.currentAttemptId,
          },
          true,
        );
  const dispatchRows =
    attempt === null
      ? { rows: [] }
      : await client.query<{ operation_id: string }>(
          `SELECT operation_id FROM ${schema}.model_dispatch_receipts
           WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND attempt_id=$4
             AND status!='terminal'
           ORDER BY request_sequence DESC LIMIT 2`,
          [input.tenantId, input.runId, node.nodeId, attempt.attemptId],
        );
  const dispatch =
    dispatchRows.rows.length !== 1 || attempt === null
      ? null
      : await loadPostgresModelDispatchReceipt(
          client,
          schema,
          {
            tenantId: input.tenantId,
            runId: input.runId,
            stepId: node.nodeId,
            attemptId: attempt.attemptId,
            operationId: dispatchRows.rows[0]!.operation_id,
          },
          true,
        );
  if (dispatchRows.rows.length > 1)
    throw new RunStoreError("workflow_cancellation_reconciliation_required");
  if (
    step === null ||
    attempt === null ||
    attempt.status !== "running" ||
    attempt.workItemId !== input.lease.workItemId ||
    attempt.leaseEpoch > input.lease.leaseEpoch ||
    (dispatch !== null &&
      (!["prepared", "possiblySent", "responseObserved"].includes(dispatch.status) ||
        (dispatch.status === "responseObserved"
          ? dispatch.responseCheckpointDigest === null
          : dispatch.responseCheckpointDigest !== null)))
  )
    throw new RunStoreError("workflow_cancellation_reconciliation_required");
  if (dispatch?.status === "possiblySent" || dispatch?.status === "responseObserved") {
    const reconciliationOperationId = `${input.operationId}:${node.nodeId}`;
    const reconciliationWorkItemId = workflowAuthorityId(
      "reconcile",
      {
        tenantId: input.tenantId,
        runId: input.runId,
        binding: input.binding,
        operationId: reconciliationOperationId,
        nodeId: node.nodeId,
        claimId: node.claimId,
        claimEpoch: node.claimEpoch,
      },
      digester,
    );
    await insertPostgresWorkflowWorkItem(
      client,
      schema,
      reconciliationWorkItemId,
      input,
      {
        schemaVersion: "crewon.workflow-reconcile-work-item.v0",
        trigger: "workflowReconcile",
        binding: input.binding,
        nodeId: node.nodeId,
        claimId: node.claimId!,
        claimEpoch: node.claimEpoch,
        reconciliationOperationId,
      },
      now,
    );
    return {
      execution: {
        ...execution,
        revision: execution.revision + 1,
        nodes: execution.nodes.map((candidate) =>
          candidate.nodeId === node.nodeId
            ? { ...candidate, status: "unknown" as const, leaseExpiresAt: null }
            : candidate,
        ),
        updatedAt: now,
      },
      reconciliationWorkItemId,
    };
  }
  if (dispatch !== null) await terminatePostgresModelDispatchForAttempt(
    client, schema, {
      tenantId: input.tenantId,
      runId: input.runId,
      lease: input.lease,
      attempt: { stepId: node.nodeId, attemptId: attempt.attemptId },
      attemptWorkItemId: attempt.workItemId,
      attemptLeaseEpoch: attempt.leaseEpoch,
      operationId: dispatch.operationId,
      requestSequence: dispatch.requestSequence,
      expectedRevision: dispatch.revision,
      transitionedAt: now,
      outcome: {
        kind: "canceled",
        code: "user_requested",
        certainty: "notSent",
      },
    });
  await finishPostgresRunAttempt(client, schema, {
    tenantId: input.tenantId,
    runId: input.runId,
    workItemId: attempt.workItemId,
    leaseEpoch: attempt.leaseEpoch,
    attempt: {
      stepId: node.nodeId,
      attemptId: attempt.attemptId,
      status: "canceled",
      finishedAt: now,
      checkpointDigest: null,
    },
  });
  await appendPostgresCanceledWorkflowNodeEvent(client, schema, {
    ...input, nodeId: node.nodeId, claimId: node.claimId,
    claimEpoch: node.claimEpoch, attemptId: attempt.attemptId,
    operationId: `${input.operationId}:${node.nodeId}`,
  }, now, digester);
  return {
    execution: {
      ...execution,
      revision: execution.revision + 1,
      nodes: execution.nodes.map((candidate) =>
        candidate.nodeId === node.nodeId
          ? {
              ...candidate,
              status: "canceled" as const,
              leaseExpiresAt: null,
              resultDigest: null,
              failureCode: null,
            }
          : candidate,
      ),
      updatedAt: now,
    },
    reconciliationWorkItemId: null,
  };
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
): Promise<boolean> {
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
    stableJson(row?.work_item_json.payload) !== stableJson(expectedPayload)
  )
    throw new RunStoreError("workflow_cancellation_reconciliation_required");
  if (row?.status === "leased") return false;
  if (row?.status !== "pending")
    throw new RunStoreError("workflow_cancellation_reconciliation_required");
  const updated = await client.query(
    `UPDATE ${schema}.work_items SET status='completed',completed_at=$1
     WHERE work_item_id=$2 AND status='pending'`,
    [now, row.work_item_id],
  );
  if (updated.rowCount !== 1)
    throw new RunStoreError("workflow_cancellation_reconciliation_required");
  await insertPostgresCanceledWorkflowStep(
    client,
    schema,
    input,
    node.nodeId,
    node.kind,
    now,
  );
  return true;
}

async function cancelGate(
  client: PoolClient,
  schema: string,
  input: Input,
  nodeId: string,
  now: string,
) {
  const gate = await client.query(
    `UPDATE ${schema}.workflow_gate_requests SET status='canceled',updated_at=$1,
     state_json=jsonb_set(jsonb_set(state_json,'{status}','"canceled"'::jsonb),
       '{updatedAt}',to_jsonb($5::text))
     WHERE tenant_id=$2 AND run_id=$3 AND node_id=$4
     AND status IN ('publicationPending','published')`,
    [now, input.tenantId, input.runId, nodeId, now],
  );
  await client.query(
    `UPDATE ${schema}.outbox SET status='delivered',lease_owner_id=NULL,lease_id=NULL,
       lease_expires_at=NULL,delivered_at=$1
     WHERE message_id=(SELECT publication_outbox_message_id
       FROM ${schema}.workflow_gate_requests
       WHERE tenant_id=$2 AND run_id=$3 AND node_id=$4)
     AND status IN ('pending','leased')`,
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

export async function insertPostgresCanceledWorkflowStep(
  client: PoolClient,
  schema: string,
  input: Readonly<{ tenantId: string; runId: string }>,
  nodeId: string,
  nodeKind: "agent" | "verification" | "humanGate",
  now: string,
) {
  const step = {
    schemaVersion: "crewon.run-step.v0" as const,
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

function projectCancellationStatus<Execution extends Result["execution"]>(
  execution: Execution,
): Execution {
  const active = execution.nodes.some((node) =>
    ["queued", "running", "unknown"].includes(node.status));
  const waiting = execution.nodes.some((node) => node.status === "waitingHuman");
  return { ...execution, status: active ? "running" as const
      : waiting ? "waitingHuman" as const : "canceled" as const };
}

async function ensureCancellationReconciliationWorkItems(
  client: PoolClient,
  schema: string,
  input: Input,
  execution: Result["execution"],
  executionOrder: readonly string[],
  now: string,
  digester: WorkflowContentDigester,
): Promise<string[]> {
  const ids: string[] = [];
  for (const nodeId of executionOrder) {
    const node = execution.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (node === undefined)
      throw new RunStoreError("workflow_composition_authority_mismatch");
    const work = await client.query<{ work_item_id: string; status: string;
      work_item_json: { payload?: Record<string, unknown> } }>(
      `SELECT work_item_id,status,work_item_json FROM ${schema}.work_items
       WHERE tenant_id=$1 AND run_id=$2
         AND work_item_json->'payload'->>'trigger'='workflowReconcile'
         AND work_item_json->'payload'->>'nodeId'=$3
         AND work_item_json->'payload'->>'claimId'=$4
         AND (work_item_json->'payload'->>'claimEpoch')::integer=$5
       ORDER BY created_at,work_item_id FOR UPDATE`,
      [input.tenantId, input.runId, node.nodeId, node.claimId, node.claimEpoch]);
    const validated = work.rows.map((row) => {
      const payload = row.work_item_json.payload;
      if (payload === undefined ||
          typeof payload.reconciliationOperationId !== "string" ||
          !["pending", "leased", "completed"].includes(row.status) ||
          row.work_item_id !== workflowAuthorityId("reconcile", {
            tenantId: input.tenantId, runId: input.runId, binding: input.binding,
            operationId: payload.reconciliationOperationId, nodeId: node.nodeId,
            claimId: node.claimId, claimEpoch: node.claimEpoch }, digester) ||
          stableJson(payload) !== stableJson({
            schemaVersion: "crewon.workflow-reconcile-work-item.v0",
            trigger: "workflowReconcile", binding: input.binding,
            nodeId: node.nodeId, claimId: node.claimId, claimEpoch: node.claimEpoch,
            reconciliationOperationId: payload.reconciliationOperationId }))
        throw new RunStoreError("workflow_cancellation_reconciliation_required");
      return row;
    });
    const active = validated.filter((row) =>
      row.status === "pending" || row.status === "leased");
    if (active.length > 1)
      throw new RunStoreError("workflow_cancellation_reconciliation_required");
    if (node.status === "unknown" && active.length === 0) {
      if (node.claimId === null)
        throw new RunStoreError("workflow_cancellation_reconciliation_required");
      const reconciliationOperationId =
        `${input.operationId}:${node.nodeId}:reconcile:${validated.length + 1}`;
      const workItemId = workflowAuthorityId("reconcile", {
        tenantId: input.tenantId, runId: input.runId, binding: input.binding,
        operationId: reconciliationOperationId, nodeId: node.nodeId,
        claimId: node.claimId, claimEpoch: node.claimEpoch }, digester);
      await insertPostgresWorkflowWorkItem(client, schema, workItemId, input, {
        schemaVersion: "crewon.workflow-reconcile-work-item.v0",
        trigger: "workflowReconcile", binding: input.binding,
        nodeId: node.nodeId, claimId: node.claimId, claimEpoch: node.claimEpoch,
        reconciliationOperationId }, now);
      ids.push(workItemId);
      continue;
    }
    const proof = active[0] ?? validated.at(-1);
    if (proof !== undefined) ids.push(proof.work_item_id);
  }
  ids.sort();
  return ids;
}

async function validateReplay(
  client: PoolClient,
  schema: string,
  input: Input,
  result: Result,
  digester: WorkflowContentDigester,
): Promise<Result> {
  const terminal = result.runDisposition === "terminalConverged";
  const pending = result.disposition === "cancellationPending";
  const reconciliation = result.disposition === "reconciliationScheduled";
  if (
    !validCancellationProof(result) ||
    result.handoff.currentWorkItem !== "completed" ||
    (terminal && result.execution.status !== "canceled") ||
    (result.disposition === "canceled" &&
      (!terminal || result.handoff.nextWorkItemId !== null ||
        result.handoff.kind !== "none")) ||
    (pending && (result.runDisposition !== "nonTerminal" ||
      result.handoff.nextWorkItemId !== null || result.handoff.kind !== "none")) ||
    (reconciliation &&
      ((!terminal && (result.runDisposition !== "nonTerminal" ||
        result.execution.status !== "running")) ||
        result.handoff.nextWorkItemId === null ||
        result.handoff.kind !== "reconcile")) ||
    (!terminal && !pending && !reconciliation)
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
    !isCancellationReplayExecutionCompatible(result.execution, current)
  )
    throw new RunStoreError("workflow_composition_receipt_corrupt");
  const currentWork = await client.query<{ status: string }>(
    `SELECT status FROM ${schema}.work_items WHERE work_item_id=$1`,
    [input.lease.workItemId]);
  if (currentWork.rows.length !== 1 || currentWork.rows[0]!.status !== "completed")
    throw new RunStoreError("workflow_composition_receipt_corrupt");
  if (reconciliation) {
    if (result.reconciliationWorkItemIds.length === 0 ||
        result.handoff.nextWorkItemId !== result.reconciliationWorkItemIds[0])
      throw new RunStoreError("workflow_composition_receipt_corrupt");
    for (const workItemId of result.reconciliationWorkItemIds)
      await validateReconciliationReplayWorkItem(
        client, schema, input, workItemId, result.execution, digester);
  } else if (result.reconciliationWorkItemIds.length !== 0) {
    throw new RunStoreError("workflow_composition_receipt_corrupt");
  }
  for (const nodeId of result.canceledNodeIds) {
    const node = result.execution.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (node?.status !== "canceled")
      throw new RunStoreError("workflow_composition_receipt_corrupt");
    const step = await loadPostgresRunStep(client, schema, {
      tenantId: input.tenantId, runId: input.runId, stepId: nodeId }, true);
    if (step?.status !== "canceled")
      throw new RunStoreError("workflow_composition_receipt_corrupt");
    await validatePostgresCanceledWorkflowNodeEvent(client, schema, {
      ...input, nodeId, claimId: node.claimId,
      claimEpoch: node.claimId === null ? null : node.claimEpoch,
      attemptId: step.currentAttemptId,
      operationId: `${input.operationId}:${nodeId}` }, digester);
  }
  for (const nodeId of result.canceledGateRequestNodeIds) {
    if (!result.canceledNodeIds.includes(nodeId))
      throw new RunStoreError("workflow_composition_receipt_corrupt");
    const gate = await client.query<{ status: string }>(
      `SELECT status FROM ${schema}.workflow_gate_requests
       WHERE tenant_id=$1 AND run_id=$2 AND node_id=$3`,
      [input.tenantId, input.runId, nodeId]);
    if (gate.rows.length !== 1 || gate.rows[0]!.status !== "canceled")
      throw new RunStoreError("workflow_composition_receipt_corrupt");
  }
  if (terminal)
    await validatePostgresTerminalWorkflowRun(
      client,
      schema,
      input as never,
      result as never,
      digester,
    );
  return { ...structuredClone(result), disposition: "replay" };
}

function validCancellationProof(result: Result): boolean {
  const proofLists = [result.canceledNodeIds,
    result.canceledGateRequestNodeIds, result.reconciliationWorkItemIds];
  return proofLists.every((ids) => ids.every((id, index) =>
    id.length > 0 && (index === 0 || ids[index - 1]! < id))) &&
    result.canceledGateRequestNodeIds.every((nodeId) =>
      result.canceledNodeIds.includes(nodeId)) &&
    result.canceledNodeIds.every((nodeId) => result.execution.nodes.find(
      (node) => node.nodeId === nodeId)?.status === "canceled") &&
    (result.handoff.kind === "reconcile"
      ? result.reconciliationWorkItemIds[0] === result.handoff.nextWorkItemId
      : result.reconciliationWorkItemIds.length === 0);
}

function isCancellationReplayExecutionCompatible(
  receipt: Result["execution"],
  current: Result["execution"],
): boolean {
  if (current.revision < receipt.revision ||
      receipt.nodes.length !== current.nodes.length ||
      receipt.workflowId !== current.workflowId ||
      receipt.workflowVersionId !== current.workflowVersionId ||
      receipt.contentDigest !== current.contentDigest) return false;
  return receipt.nodes.every((node, index) => {
    const candidate = current.nodes[index];
    if (candidate === undefined || candidate.nodeId !== node.nodeId ||
        candidate.claimId !== node.claimId || candidate.claimEpoch !== node.claimEpoch)
      return false;
    if (node.status === "canceled") return candidate.status === "canceled";
    if (node.status === "unknown")
      return candidate.status === "unknown" || candidate.status === "canceled";
    return candidate.status === node.status || candidate.status === "canceled";
  });
}

async function validateReconciliationReplayWorkItem(
  client: PoolClient,
  schema: string,
  input: Input,
  workItemId: string,
  receiptExecution: Result["execution"],
  digester: WorkflowContentDigester,
): Promise<void> {
  const work = await client.query<{ status: string;
    work_item_json: { payload?: Record<string, unknown> } }>(
      `SELECT status,work_item_json FROM ${schema}.work_items WHERE work_item_id=$1`,
      [workItemId]);
  const row = work.rows[0];
  const payload = row?.work_item_json.payload;
  const node = receiptExecution.nodes.find((candidate) => candidate.nodeId === payload?.nodeId);
  if (work.rows.length !== 1 || payload === undefined || node === undefined ||
      !["unknown", "canceled"].includes(node.status) ||
      typeof payload.reconciliationOperationId !== "string" ||
      !["pending", "leased", "completed"].includes(row!.status) ||
      workItemId !== workflowAuthorityId("reconcile", {
        tenantId: input.tenantId, runId: input.runId, binding: input.binding,
        operationId: payload.reconciliationOperationId, nodeId: node.nodeId,
        claimId: node.claimId, claimEpoch: node.claimEpoch }, digester) ||
      stableJson(payload) !== stableJson({
        schemaVersion: "crewon.workflow-reconcile-work-item.v0",
        trigger: "workflowReconcile", binding: input.binding,
        nodeId: node.nodeId, claimId: node.claimId, claimEpoch: node.claimEpoch,
        reconciliationOperationId: payload.reconciliationOperationId }))
    throw new RunStoreError("workflow_composition_receipt_corrupt");
}
