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
  transitionPostgresModelDispatch,
} from "./postgres-model-dispatch-evidence.ts";
import {
  convergePostgresWorkflowRun,
  validatePostgresTerminalWorkflowRun,
} from "./postgres-workflow-node-settlement.ts";
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
    const result = { disposition: canceled.reconciliationWorkItemId === null
        ? "cancellationPending" as const : "reconciliationScheduled" as const,
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
  const reconciliationWorkItemIds = await loadCancellationReconciliationWorkItems(
    client, schema, input, execution, digester);
  let retryRequired = execution.nodes.some((node) => node.status === "running");
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
      if (await cancelQueuedNode(client, schema, input, node, now))
        nodes.push({ ...node, status: "canceled" as const });
      else { retryRequired = true; nodes.push(node); }
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
    status: "running" as const,
    updatedAt: now,
  };
  const projected = projectCancellationStatus(next);
  await writePostgresWorkflowExecution(client, schema, projected, now);
  if (retryRequired) return structuredClone({ disposition: "retryRequired" as const,
    execution: projected, handoff: { currentWorkItem: "retained" as const,
      nextWorkItemId: null, kind: "none" as const }, runDisposition: "nonTerminal" as const });
  const reconciliationWorkItemId = reconciliationWorkItemIds[0] ?? null;
  const runDisposition =
    reconciliationWorkItemId === null
      ? await convergePostgresWorkflowRun(
          client,
          schema,
          input as never,
          workflow,
          projected,
          now,
          digester,
        )
      : ("nonTerminal" as const);
  const result = {
    disposition:
      reconciliationWorkItemId === null
        ? ("canceled" as const)
        : ("reconciliationScheduled" as const),
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
    attempt.leaseEpoch !== input.lease.leaseEpoch ||
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
  if (dispatch !== null) await transitionPostgresModelDispatch(
    client, schema, {
      tenantId: input.tenantId,
      runId: input.runId,
      lease: input.lease,
      attempt: { stepId: node.nodeId, attemptId: attempt.attemptId },
      operationId: dispatch.operationId,
      requestSequence: dispatch.requestSequence,
      expectedRevision: dispatch.revision,
      transitionedAt: now,
      outcome: {
        kind: "canceled",
        code: "user_requested",
        certainty: "notSent",
      },
    }, "terminal");
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
  await insertCanceledStep(client, schema, input, node.nodeId, node.kind, now);
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

function projectCancellationStatus<Execution extends Result["execution"]>(
  execution: Execution,
): Execution {
  const active = execution.nodes.some((node) =>
    ["queued", "running", "unknown"].includes(node.status));
  const waiting = execution.nodes.some((node) => node.status === "waitingHuman");
  return { ...execution, status: active ? "running" as const
      : waiting ? "waitingHuman" as const : "canceled" as const };
}

async function loadCancellationReconciliationWorkItems(
  client: PoolClient,
  schema: string,
  input: Input,
  execution: Result["execution"],
  digester: WorkflowContentDigester,
): Promise<string[]> {
  const ids: string[] = [];
  for (const node of execution.nodes) {
    if (node.status !== "unknown") continue;
    const work = await client.query<{ work_item_id: string; status: string;
      work_item_json: { payload?: Record<string, unknown> } }>(
      `SELECT work_item_id,status,work_item_json FROM ${schema}.work_items
       WHERE tenant_id=$1 AND run_id=$2
         AND work_item_json->'payload'->>'trigger'='workflowReconcile'
         AND work_item_json->'payload'->>'nodeId'=$3
         AND work_item_json->'payload'->>'claimId'=$4
         AND (work_item_json->'payload'->>'claimEpoch')::integer=$5 FOR UPDATE`,
      [input.tenantId, input.runId, node.nodeId, node.claimId, node.claimEpoch]);
    const row = work.rows[0];
    const payload = row?.work_item_json.payload;
    if (work.rows.length !== 1 || payload === undefined ||
        typeof payload.reconciliationOperationId !== "string" ||
        !["pending", "leased", "completed"].includes(row!.status) ||
        row!.work_item_id !== workflowAuthorityId("reconcile", {
          tenantId: input.tenantId, runId: input.runId, binding: input.binding,
          operationId: payload.reconciliationOperationId, nodeId: node.nodeId,
          claimId: node.claimId, claimEpoch: node.claimEpoch }, digester))
      throw new RunStoreError("workflow_cancellation_reconciliation_required");
    ids.push(row.work_item_id);
  }
  return ids;
}

async function validateReplay(
  client: PoolClient,
  schema: string,
  input: Input,
  result: Result,
  digester: WorkflowContentDigester,
): Promise<Result> {
  const terminal = result.disposition === "canceled";
  const pending = result.disposition === "cancellationPending";
  if (
    result.handoff.currentWorkItem !== "completed" ||
    (terminal &&
      (result.runDisposition !== "terminalConverged" ||
        result.execution.status !== "canceled" ||
        result.handoff.nextWorkItemId !== null ||
        result.handoff.kind !== "none")) ||
    (pending && (result.runDisposition !== "nonTerminal" ||
      result.handoff.nextWorkItemId !== null || result.handoff.kind !== "none")) ||
    (!terminal && !pending &&
      (result.runDisposition !== "nonTerminal" ||
        result.execution.status !== "running" ||
        result.handoff.nextWorkItemId === null ||
        result.handoff.kind !== "reconcile"))
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
