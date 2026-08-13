import {
  RunStoreError,
  validateWorkflowNodeContinuationCheckpoint,
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
import { convergePostgresWorkflowRun } from "./postgres-workflow-node-settlement.ts";
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
  WorkflowRunCompositionStore["reconcileWorkflowNode"]
>[0];
type Result = Awaited<
  ReturnType<WorkflowRunCompositionStore["reconcileWorkflowNode"]>
>;

export async function reconcilePostgresWorkflowNode(
  client: PoolClient,
  schema: string,
  input: Input,
  digester: WorkflowContentDigester,
): Promise<Result> {
  const receiptInput = {
    ...input,
    operationId: `reconcile:${input.reconciliationOperationId}`,
  };
  const fingerprint = postgresWorkflowFingerprint(
    "reconcileNode",
    input,
    digester,
  );
  const replay = await loadPostgresWorkflowReceipt(
    client,
    schema,
    receiptInput,
    "reconcileNode",
    fingerprint,
  );
  if (replay !== null)
    return { ...(structuredClone(replay) as Result), disposition: "replay" };
  const now = await validatePostgresWorkflowLease(client, schema, input);
  const workflow = await loadPostgresWorkflowAuthorities(
    client,
    schema,
    input,
    digester,
  );
  const work = await client.query<{ work_item_json: { payload?: unknown } }>(
    `SELECT work_item_json FROM ${schema}.work_items WHERE work_item_id=$1 FOR UPDATE`,
    [input.lease.workItemId],
  );
  if (
    stableJson(work.rows[0]?.work_item_json.payload) !==
    stableJson({
      schemaVersion: "crewon.workflow-reconcile-work-item.v0",
      trigger: "workflowReconcile",
      binding: input.binding,
      nodeId: input.nodeId,
      claimId: input.claimId,
      claimEpoch: input.claimEpoch,
      reconciliationOperationId: input.reconciliationOperationId,
    })
  )
    throw new RunStoreError("workflow_composition_work_item_mismatch");
  const execution = await loadPostgresWorkflowExecution(
    client,
    schema,
    input,
    true,
  );
  const node = execution?.nodes.find(
    (candidate) => candidate.nodeId === input.nodeId,
  );
  const step = await loadPostgresRunStep(
    client,
    schema,
    {
      tenantId: input.tenantId,
      runId: input.runId,
      stepId: input.nodeId,
    },
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
  if (
    execution === null ||
    node?.status !== "unknown" ||
    node.claimId !== input.claimId ||
    node.claimEpoch !== input.claimEpoch ||
    attempt?.status !== "running"
  )
    throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
  const operations = await client.query<{ operation_id: string }>(
    `SELECT operation_id FROM ${schema}.model_dispatch_receipts
     WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND attempt_id=$4
     ORDER BY request_sequence DESC LIMIT 2`,
    [input.tenantId, input.runId, input.nodeId, attempt.attemptId],
  );
  const dispatch =
    operations.rows.length !== 1
      ? null
      : await loadPostgresModelDispatchReceipt(
          client,
          schema,
          {
            tenantId: input.tenantId,
            runId: input.runId,
            stepId: input.nodeId,
            attemptId: attempt.attemptId,
            operationId: operations.rows[0]!.operation_id,
          },
          true,
        );
  if (
    dispatch === null ||
    dispatch.workItemId !== attempt.workItemId ||
    dispatch.leaseEpoch !== attempt.leaseEpoch
  )
    throw new RunStoreError("workflow_reconciliation_evidence_missing");
  const evidenceStatus =
    dispatch.status === "prepared"
      ? ("notDispatched" as const)
      : dispatch.status;
  if (evidenceStatus === "notDispatched") {
    await finishPostgresRunAttempt(client, schema, {
      tenantId: input.tenantId,
      runId: input.runId,
      workItemId: attempt.workItemId,
      leaseEpoch: attempt.leaseEpoch,
      attempt: {
        stepId: input.nodeId,
        attemptId: attempt.attemptId,
        status: "failed",
        finishedAt: now,
        checkpointDigest: null,
        failure: { code: "workflow_model_not_dispatched", retryable: true },
      },
    });
    const claimEpoch = input.claimEpoch + 1;
    const claimAuthority = {
      tenantId: input.tenantId,
      runId: input.runId,
      binding: input.binding,
      nodeId: input.nodeId,
      claimEpoch,
      reconciliationOperationId: input.reconciliationOperationId,
    };
    const claimId = workflowAuthorityId("claim", claimAuthority, digester);
    const workAuthority = {
      ...claimAuthority,
      claimId,
      schedulerOperationId: input.reconciliationOperationId,
    };
    const workItemId = workflowAuthorityId("node", workAuthority, digester);
    const next = {
      ...execution,
      revision: execution.revision + 1,
      nodes: execution.nodes.map((candidate) =>
        candidate.nodeId === input.nodeId
          ? {
              ...candidate,
              status: "queued" as const,
              claimId,
              claimOperationId: input.reconciliationOperationId,
              claimEpoch,
              leaseExpiresAt: null,
              gateRequestId: null,
              resultDigest: null,
              failureCode: null,
            }
          : candidate,
      ),
      updatedAt: now,
    };
    await writePostgresWorkflowExecution(client, schema, next, now);
    await insertPostgresWorkflowWorkItem(
      client,
      schema,
      workItemId,
      input,
      {
        schemaVersion: "crewon.workflow-node-work-item.v0",
        trigger: "workflowNode",
        binding: input.binding,
        nodeId: input.nodeId,
        claimId,
        claimEpoch,
        schedulerOperationId: input.reconciliationOperationId,
      },
      now,
    );
    const result = {
      disposition: "retryScheduled" as const,
      evidenceStatus,
      execution: next,
      handoff: {
        currentWorkItem: "completed" as const,
        nextWorkItemId: workItemId,
        kind: "node" as const,
      },
      runDisposition: "nonTerminal" as const,
    };
    await insertPostgresWorkflowReceipt(
      client,
      schema,
      receiptInput,
      "reconcileNode",
      fingerprint,
      result,
    );
    await completePostgresWorkflowLease(client, schema, input, now);
    return structuredClone(result);
  }
  if (evidenceStatus === "possiblySent")
    return {
      disposition: "retryRequired",
      evidenceStatus,
      execution,
      handoff: {
        currentWorkItem: "retained",
        nextWorkItemId: null,
        kind: "none",
      },
      runDisposition: "nonTerminal",
    };
  if (dispatch.status !== "responseObserved")
    throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
  const continuation = await client.query<{ state_json: unknown }>(
    `SELECT state_json FROM ${schema}.workflow_node_continuations
     WHERE tenant_id=$1 AND run_id=$2 AND node_id=$3 FOR UPDATE`,
    [input.tenantId, input.runId, input.nodeId],
  );
  const checkpoint =
    continuation.rows[0] === undefined
      ? null
      : validateWorkflowNodeContinuationCheckpoint(
          continuation.rows[0].state_json,
        );
  const candidate = checkpoint?.terminalCandidate;
  if (
    candidate === null ||
    candidate === undefined ||
    checkpoint!.authority.attempt.attemptId !== attempt.attemptId
  )
    throw new RunStoreError("workflow_terminal_candidate_corrupt");
  const run = await client.query<{ state_json: { cancelRequested?: unknown } }>(
    `SELECT state_json FROM ${schema}.run_snapshots WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
    [input.tenantId, input.runId],
  );
  if (run.rows[0]?.state_json.cancelRequested !== true)
    throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
  await terminatePostgresModelDispatchForAttempt(client, schema, {
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
    outcome: candidate.dispatchTerminalOutcome,
  });
  await finishPostgresRunAttempt(client, schema, {
    tenantId: input.tenantId,
    runId: input.runId,
    workItemId: attempt.workItemId,
    leaseEpoch: attempt.leaseEpoch,
    attempt: {
      stepId: input.nodeId,
      attemptId: attempt.attemptId,
      status: "canceled",
      finishedAt: now,
      checkpointDigest: dispatch.responseCheckpointDigest,
    },
  });
  const nodes = execution.nodes.map((item) =>
    item.nodeId === input.nodeId
      ? {
          ...item,
          status: "canceled" as const,
          leaseExpiresAt: null,
          resultDigest: null,
          failureCode: null,
        }
      : item,
  );
  const next = {
    ...execution,
    revision: execution.revision + 1,
    nodes,
    status: nodes.some((node) =>
      ["queued", "running", "unknown"].includes(node.status))
      ? "running" as const
      : nodes.some((node) => node.status === "waitingHuman")
        ? "waitingHuman" as const
        : "canceled" as const,
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
    disposition: "settled" as const,
    evidenceStatus,
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
    receiptInput,
    "reconcileNode",
    fingerprint,
    result,
  );
  await completePostgresWorkflowLease(client, schema, input, now);
  return structuredClone(result);
}
