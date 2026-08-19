import type {
  WorkflowExecutionState,
  WorkflowRunCompositionStore,
} from "@crewon/application";
import { RunStoreError } from "@crewon/application";
import type {
  ModelDispatchReceipt,
  RunAttemptState,
  WorkflowContentDigester,
} from "@crewon/domain";
import type { PoolClient } from "pg";

import {
  loadPostgresRunAttempt,
  loadPostgresRunStep,
} from "./postgres-execution-authority.ts";
import {
  loadPostgresModelDispatchReceipt,
  terminatePostgresModelDispatchForAttempt,
} from "./postgres-model-dispatch-evidence.ts";
import {
  settlePostgresWorkflowNode,
  validatePostgresTerminalWorkflowRun,
} from "./postgres-workflow-node-settlement.ts";
import { validatePostgresWorkflowNodeTerminalEvent } from "./postgres-workflow-cancellation-lifecycle.ts";
import { validateWorkflowExecutionState } from "./workflow-execution-state.ts";
import {
  assertExecutionBinding,
  workflowAuthorityId,
} from "./workflow-run-composition-support.ts";
import {
  insertPostgresWorkflowReceipt,
  loadPostgresWorkflowAuthorities,
  loadPostgresWorkflowExecution,
} from "./postgres-workflow-run-composition-transactions.ts";

type Input = Parameters<
  WorkflowRunCompositionStore["reconcileWorkflowNode"]
>[0];
type Result = Extract<
  Awaited<ReturnType<WorkflowRunCompositionStore["reconcileWorkflowNode"]>>,
  { disposition: "operatorRequired" }
>;
type ReconciliationResult = Awaited<
  ReturnType<WorkflowRunCompositionStore["reconcileWorkflowNode"]>
>;

export async function settlePostgresWorkflowOperatorRequired(
  client: PoolClient,
  schema: string,
  input: Input,
  execution: WorkflowExecutionState,
  attempt: RunAttemptState & Readonly<{ status: "running" }>,
  dispatch: ModelDispatchReceipt & Readonly<{ status: "possiblySent" }>,
  agentVersionId: string,
  fingerprint: string,
  now: string,
  digester: WorkflowContentDigester,
): Promise<Result> {
  const terminal = await terminatePostgresModelDispatchForAttempt(
    client,
    schema,
    {
      tenantId: input.tenantId,
      runId: input.runId,
      lease: input.lease,
      attempt: { stepId: input.nodeId, attemptId: attempt.attemptId },
      attemptWorkItemId: attempt.workItemId,
      attemptLeaseEpoch: attempt.leaseEpoch,
      operationId: dispatch.operationId,
      requestSequence: dispatch.requestSequence,
      expectedRevision: dispatch.revision,
      transitionedAt: now,
      outcome: {
        kind: "failed",
        code: "workflow_model_dispatch_operator_required",
        certainty: "operatorRequired",
      },
    },
  );
  const settled = await settlePostgresWorkflowNode(
    client,
    schema,
    {
      tenantId: input.tenantId,
      runId: input.runId,
      lease: input.lease,
      binding: input.binding,
      nodeId: input.nodeId,
      claimId: input.claimId,
      claimEpoch: input.claimEpoch,
      stepId: input.nodeId,
      attemptId: attempt.attemptId,
      operationId: `reconcile-operator:${input.reconciliationOperationId}`,
      outcome: {
        status: "failed",
        failureCode: "workflow_model_dispatch_operator_required",
      },
    },
    digester,
    {
      fingerprintAuthority: { input, evidenceStatus: "possiblySent" },
      agentVersionId,
      attemptCheckpointDigest: terminal.responseCheckpointDigest,
      reconciliationAttempt: {
        workItemId: attempt.workItemId,
        leaseEpoch: attempt.leaseEpoch,
      },
    },
  );
  if (settled.handoff.currentWorkItem !== "completed")
    throw new RunStoreError("workflow_reconciliation_handoff_corrupt");
  const result = {
    disposition: "operatorRequired" as const,
    evidenceStatus: "possiblySent" as const,
    execution: settled.execution,
    handoff: { ...settled.handoff, currentWorkItem: "completed" as const },
    runDisposition: settled.runDisposition,
  };
  await insertPostgresWorkflowReceipt(
    client,
    schema,
    {
      ...input,
      operationId: `reconcile:${input.reconciliationOperationId}`,
    },
    "reconcileNode",
    fingerprint,
    result,
  );
  return structuredClone(result);
}

export async function validatePostgresWorkflowOperatorRequiredReplay(
  client: PoolClient,
  schema: string,
  input: Input,
  stored: Result,
  digester: WorkflowContentDigester,
): Promise<ReconciliationResult> {
  validateWorkflowExecutionState(stored.execution);
  const workflow = await loadPostgresWorkflowAuthorities(
    client,
    schema,
    input,
    digester,
    true,
  );
  assertExecutionBinding(
    stored.execution,
    input.tenantId,
    input.runId,
    input.binding,
    workflow,
  );
  const node = stored.execution.nodes.find(
    (candidate) => candidate.nodeId === input.nodeId,
  );
  const current = await loadPostgresWorkflowExecution(
    client,
    schema,
    input,
    true,
  );
  const step = await loadPostgresRunStep(
    client,
    schema,
    { ...input, stepId: input.nodeId },
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
            stepId: input.nodeId,
            attemptId: step.currentAttemptId,
          },
          true,
        );
  const currentNode = current?.nodes.find(
    (candidate) => candidate.nodeId === input.nodeId,
  );
  const operation =
    attempt === null
      ? null
      : await client.query<{
          operation_id: string | null;
          operator_count: number | string;
          operator_sequence: number | string | null;
          max_sequence: number | string | null;
          nonterminal_count: number | string;
        }>(
          `SELECT
           max(operation_id) FILTER (WHERE status='terminal'
             AND state_json->'terminalOutcome'->>'kind'='failed'
             AND state_json->'terminalOutcome'->>'code'=
               'workflow_model_dispatch_operator_required'
             AND state_json->'terminalOutcome'->>'certainty'='operatorRequired') operation_id,
           count(*) FILTER (WHERE status='terminal'
             AND state_json->'terminalOutcome'->>'kind'='failed'
             AND state_json->'terminalOutcome'->>'code'=
               'workflow_model_dispatch_operator_required'
             AND state_json->'terminalOutcome'->>'certainty'='operatorRequired') operator_count,
           max(request_sequence) FILTER (WHERE status='terminal'
             AND state_json->'terminalOutcome'->>'kind'='failed'
             AND state_json->'terminalOutcome'->>'code'=
               'workflow_model_dispatch_operator_required'
             AND state_json->'terminalOutcome'->>'certainty'='operatorRequired') operator_sequence,
           max(request_sequence) max_sequence,
           count(*) FILTER (WHERE status!='terminal') nonterminal_count
           FROM ${schema}.model_dispatch_receipts
           WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND attempt_id=$4`,
          [input.tenantId, input.runId, input.nodeId, attempt.attemptId],
        );
  const operationRow = operation?.rows[0];
  const dispatch =
    attempt === null ||
    operationRow?.operation_id === null ||
    operationRow?.operation_id === undefined
      ? null
      : await loadPostgresModelDispatchReceipt(
          client,
          schema,
          {
            tenantId: input.tenantId,
            runId: input.runId,
            stepId: input.nodeId,
            attemptId: attempt.attemptId,
            operationId: operationRow.operation_id,
          },
          true,
        );
  const work = await client.query<{
    tenant_id: string;
    run_id: string;
    status: string;
    lease_owner_id: string | null;
    lease_id: string | null;
    lease_expires_at: unknown;
    lease_epoch: number | string;
  }>(
    `SELECT tenant_id,run_id,status,lease_owner_id,lease_id,
     lease_expires_at,lease_epoch FROM ${schema}.work_items
     WHERE work_item_id=$1 FOR UPDATE`,
    [input.lease.workItemId],
  );
  const workRow = work.rows[0];
  if (
    stored.evidenceStatus !== "possiblySent" ||
    stored.handoff.currentWorkItem !== "completed" ||
    node?.status !== "failed" ||
    node.failureCode !== "workflow_model_dispatch_operator_required" ||
    current === null ||
    current.revision < stored.execution.revision ||
    currentNode?.status !== "failed" ||
    currentNode.claimId !== input.claimId ||
    currentNode.claimEpoch !== input.claimEpoch ||
    currentNode.failureCode !== "workflow_model_dispatch_operator_required" ||
    step?.status !== "failed" ||
    attempt?.status !== "failed" ||
    attempt.failure?.code !== "workflow_model_dispatch_operator_required" ||
    attempt.failure.retryable !== false ||
    dispatch?.status !== "terminal" ||
    Number(operationRow?.operator_count) !== 1 ||
    Number(operationRow?.operator_sequence) !==
      Number(operationRow?.max_sequence) ||
    Number(operationRow?.nonterminal_count) !== 0 ||
    dispatch.terminalOutcome?.kind !== "failed" ||
    dispatch.terminalOutcome.code !==
      "workflow_model_dispatch_operator_required" ||
    dispatch.terminalOutcome.certainty !== "operatorRequired" ||
    dispatch.workItemId !== attempt.workItemId ||
    dispatch.leaseEpoch !== attempt.leaseEpoch ||
    workRow?.tenant_id !== input.tenantId ||
    workRow.run_id !== input.runId ||
    workRow.status !== "completed" ||
    Number(workRow.lease_epoch) !== input.lease.leaseEpoch ||
    workRow.lease_owner_id !== null ||
    workRow.lease_id !== null ||
    workRow.lease_expires_at !== null
  )
    corrupt();
  const settlementInput = operatorSettlementInput(input, attempt.attemptId);
  await validatePostgresWorkflowNodeTerminalEvent(
    client,
    schema,
    {
      tenantId: input.tenantId,
      runId: input.runId,
      binding: input.binding,
      nodeId: input.nodeId,
      claimId: input.claimId,
      claimEpoch: input.claimEpoch,
      attemptId: attempt.attemptId,
      operationId: settlementInput.operationId,
      status: "failed",
      resultDigest: null,
      failureCode: "workflow_model_dispatch_operator_required",
    },
    digester,
  );
  if (stored.handoff.nextWorkItemId === null) {
    if (stored.handoff.kind !== "none") corrupt();
  } else {
    const next = await client.query<{ status: string }>(
      `SELECT status FROM ${schema}.work_items
       WHERE tenant_id=$1 AND run_id=$2 AND work_item_id=$3`,
      [input.tenantId, input.runId, stored.handoff.nextWorkItemId],
    );
    if (
      stored.handoff.kind !== "scheduler" ||
      !["pending", "leased", "completed"].includes(next.rows[0]?.status ?? "")
    )
      corrupt();
  }
  if (stored.runDisposition === "terminalConverged") {
    await validatePostgresTerminalWorkflowRun(
      client,
      schema,
      settlementInput,
      {
        disposition: "settled",
        execution: stored.execution,
        schedulerContinuationWorkItemId: null,
        handoff: stored.handoff,
        runDisposition: "terminalConverged",
      },
      digester,
    );
    const eventId = workflowAuthorityId("run-event", settlementInput, digester);
    const run = await client.query<{
      run_code: string | null;
      event_code: string | null;
    }>(
      `SELECT
       state_json->'failure'->>'code' run_code,
       (SELECT event_json->'data'->>'code' FROM ${schema}.run_events
        WHERE tenant_id=$1 AND run_id=$2 AND event_id=$3) event_code
       FROM ${schema}.run_snapshots WHERE tenant_id=$1 AND run_id=$2`,
      [input.tenantId, input.runId, eventId],
    );
    if (
      run.rows[0]?.run_code !== "workflow_model_dispatch_operator_required" ||
      run.rows[0].event_code !== "workflow_model_dispatch_operator_required"
    )
      corrupt();
  }
  return { ...structuredClone(stored), disposition: "replay" };
}

function operatorSettlementInput(input: Input, attemptId: string) {
  return {
    tenantId: input.tenantId,
    runId: input.runId,
    lease: input.lease,
    binding: input.binding,
    nodeId: input.nodeId,
    claimId: input.claimId,
    claimEpoch: input.claimEpoch,
    stepId: input.nodeId,
    attemptId,
    operationId: `reconcile-operator:${input.reconciliationOperationId}`,
    outcome: {
      status: "failed" as const,
      failureCode: "workflow_model_dispatch_operator_required",
    },
  };
}

function corrupt(): never {
  throw new RunStoreError("workflow_reconciliation_replay_corrupt");
}
