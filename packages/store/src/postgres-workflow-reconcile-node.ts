import {
  canonicalJson,
  RunStoreError,
  type WorkflowExecutionValue,
  type WorkflowRunCompositionStore,
} from "@crewon/application";
import type {
  WorkflowContentDigester,
  WorkflowNodeDefinition,
} from "@crewon/domain";
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
import { stableJson } from "./store-invariants.ts";
import {
  loadPostgresWorkflowContinuationForReconciliation,
  takeOverPostgresWorkflowContinuation,
} from "./postgres-workflow-continuation-resume.ts";
import { workflowAuthorityId } from "./workflow-run-composition-support.ts";
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
import { appendPostgresCanceledWorkflowNodeEvent } from "./postgres-workflow-cancellation-lifecycle.ts";
import { adoptPostgresWorkflowPendingTools } from "./postgres-workflow-pending-tool-resume.ts";
import { settlePostgresRetrievedWorkflowNode } from "./postgres-workflow-retrieved-settlement.ts";

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
  const work = await client.query<{
    work_item_json: { payload?: unknown };
    lease_expires_at: Date | string | null;
  }>(
    `SELECT work_item_json,lease_expires_at
     FROM ${schema}.work_items WHERE work_item_id=$1 FOR UPDATE`,
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
    node === undefined ||
    (node.status !== "unknown" &&
      (node.status !== "running" ||
        attempt?.workItemId !== input.lease.workItemId)) ||
    node.claimId !== input.claimId ||
    node.claimEpoch !== input.claimEpoch ||
    attempt?.status !== "running"
  )
    throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
  const operations = await client.query<{ operation_id: string }>(
    `SELECT operation_id FROM ${schema}.model_dispatch_receipts
     WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND attempt_id=$4
       AND status!='terminal'
     ORDER BY request_sequence DESC,revision DESC LIMIT 2`,
    [input.tenantId, input.runId, input.nodeId, attempt.attemptId],
  );
  if (operations.rows.length > 1)
    throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
  const dispatch =
    operations.rows[0] === undefined
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
    dispatch !== null &&
    (dispatch.workItemId !== attempt.workItemId ||
      dispatch.leaseEpoch !== attempt.leaseEpoch)
  )
    throw new RunStoreError("workflow_reconciliation_evidence_missing");
  const definition = workflow.nodes.find(
    (candidate) => candidate.nodeId === input.nodeId,
  );
  const inputValue = await loadPostgresWorkflowValue(
    client,
    schema,
    input,
    "nodeInput",
    input.nodeId,
    digester,
  );
  if (definition === undefined || definition.kind === "humanGate")
    throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
  const expectedAgentVersionId =
    definition.kind === "agent"
      ? definition.agentVersionId
      : definition.verifierAgentVersionId;
  const leaseExpiresAt = work.rows[0]?.lease_expires_at;
  if (
    node.agentVersionId !== expectedAgentVersionId ||
    node.inputDigest === null ||
    inputValue === null ||
    inputValue.valueDigest !== node.inputDigest ||
    leaseExpiresAt === null ||
    leaseExpiresAt === undefined
  )
    throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
  const reconciliationLeaseExpiresAt = new Date(leaseExpiresAt).toISOString();
  const authority = {
    tenantId: input.tenantId,
    runId: input.runId,
    workItemId: attempt.workItemId,
    leaseEpoch: attempt.leaseEpoch,
    nodeId: input.nodeId,
    nodeKind: definition.kind,
    claimId: input.claimId,
    claimEpoch: input.claimEpoch,
    agentVersionId: node.agentVersionId,
    attempt: {
      stepId: input.nodeId,
      attemptId: attempt.attemptId,
    },
  };
  const checkpoint = await loadPostgresWorkflowContinuationForReconciliation(
    client,
    schema,
    authority,
  );
  if (
    dispatch === null &&
    checkpoint?.activeDispatch === null &&
    checkpoint.terminalCandidate === null &&
    attempt.workItemId === input.lease.workItemId
  ) {
    const resumed = await takeOverPostgresWorkflowContinuation(client, schema, {
      authority,
      reconciliationLease: input.lease,
      attempt: { ...attempt, status: "running" },
      checkpoint,
      dispatch: null,
      resumedAt: now,
      digester,
    });
    const resumedExecution = await resumePostgresWorkflowExecution(
      client,
      schema,
      execution,
      input.nodeId,
      reconciliationLeaseExpiresAt,
      now,
    );
    const pendingTools = await adoptPostgresWorkflowPendingTools(
      client,
      schema,
      {
        sourceAuthority: authority,
        reconciliationLease: input.lease,
        continuation: resumed.continuation,
        adoptedAt: now,
        digester,
      },
    );
    return resumeRequiredResult(
      input,
      resumedExecution,
      definition!,
      node.inputDigest!,
      step!,
      resumed,
      pendingTools,
    );
  }
  if (
    dispatch?.status === "prepared" &&
    checkpoint?.activeDispatch === null &&
    checkpoint.terminalCandidate === null &&
    attempt.workItemId === input.lease.workItemId
  ) {
    const resumed = await takeOverPostgresWorkflowContinuation(client, schema, {
      authority,
      reconciliationLease: input.lease,
      attempt: { ...attempt, status: "running" },
      checkpoint,
      dispatch: { ...dispatch, status: "prepared" },
      resumedAt: now,
      digester,
    });
    const resumedExecution = await resumePostgresWorkflowExecution(
      client,
      schema,
      execution,
      input.nodeId,
      reconciliationLeaseExpiresAt,
      now,
    );
    const pendingTools = await adoptPostgresWorkflowPendingTools(
      client,
      schema,
      {
        sourceAuthority: authority,
        reconciliationLease: input.lease,
        continuation: resumed.continuation,
        adoptedAt: now,
        digester,
      },
    );
    return resumeRequiredResult(
      input,
      resumedExecution,
      definition!,
      node.inputDigest!,
      step!,
      resumed,
      pendingTools,
    );
  }
  const evidenceStatus =
    dispatch === null || dispatch.status === "prepared"
      ? ("notDispatched" as const)
      : dispatch.status;
  const run = await client.query<{ state_json: { cancelRequested?: unknown } }>(
    `SELECT state_json FROM ${schema}.run_snapshots
     WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
    [input.tenantId, input.runId],
  );
  if (evidenceStatus === "notDispatched") {
    if (run.rows[0]?.state_json.cancelRequested === true) {
      const terminal =
        dispatch === null
          ? null
          : await terminatePostgresModelDispatchForAttempt(client, schema, {
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
                kind: "canceled",
                code: "user_requested",
                certainty: "notSent",
              },
            });
      const next = await settleCanceledReconciliation(
        client,
        schema,
        input,
        execution,
        attempt,
        terminal?.responseCheckpointDigest ?? null,
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
  if (
    evidenceStatus === "possiblySent" &&
    run.rows[0]?.state_json.cancelRequested === true
  ) {
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
        operationId: dispatch!.operationId,
        requestSequence: dispatch!.requestSequence,
        expectedRevision: dispatch!.revision,
        transitionedAt: now,
        outcome: {
          kind: "canceled",
          code: "user_requested",
          certainty: "abandonedPossiblySent",
        },
      },
    );
    const next = await settleCanceledReconciliation(
      client,
      schema,
      input,
      execution,
      attempt,
      terminal.responseCheckpointDigest,
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
  if (dispatch?.status !== "responseObserved")
    throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
  const candidate = checkpoint?.terminalCandidate;
  if (candidate === null || candidate === undefined) {
    const providerCheckpoint = attempt.providerCheckpoint;
    const checkpointDigest = attempt.checkpointDigest;
    if (
      providerCheckpoint === null ||
      checkpointDigest === null ||
      digester.sha256(canonicalJson(providerCheckpoint)) !== checkpointDigest ||
      dispatch.responseCheckpointDigest !== checkpointDigest ||
      dispatch.operation !== "dispatch" ||
      dispatch.provider.agentVersionId !== node.agentVersionId ||
      dispatch.provider.adapterName !== providerCheckpoint.adapterName ||
      dispatch.provider.adapterVersion !== providerCheckpoint.adapterVersion ||
      dispatch.provider.modelId !== providerCheckpoint.modelId
    )
      throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
    if (
      checkpoint?.activeDispatch?.operationId === dispatch.operationId &&
      checkpoint.activeDispatch.requestSequence === dispatch.requestSequence &&
      checkpoint.activeDispatch.expectedRevision === dispatch.revision &&
      checkpoint.activeDispatch.status === "responseObserved"
    ) {
      const resumed = await takeOverPostgresWorkflowContinuation(
        client,
        schema,
        {
          authority,
          reconciliationLease: input.lease,
          attempt: { ...attempt, status: "running" },
          checkpoint,
          dispatch: { ...dispatch, status: "responseObserved" },
          resumedAt: now,
          digester,
        },
      );
      const resumedExecution = await resumePostgresWorkflowExecution(
        client,
        schema,
        execution,
        input.nodeId,
        reconciliationLeaseExpiresAt,
        now,
      );
      const pendingTools = await adoptPostgresWorkflowPendingTools(
        client,
        schema,
        {
          sourceAuthority: authority,
          reconciliationLease: input.lease,
          continuation: resumed.continuation,
          adoptedAt: now,
          digester,
        },
      );
      return resumeRequiredResult(
        input,
        resumedExecution,
        definition,
        node.inputDigest!,
        step!,
        resumed,
        pendingTools,
      );
    }
    return structuredClone({
      disposition: "retrieveRequired" as const,
      evidenceStatus: "responseObserved" as const,
      execution,
      recovery: {
        claim: {
          node: definition,
          claimId: input.claimId,
          claimEpoch: input.claimEpoch,
          gateRequestId: null,
          inputDigest: node.inputDigest!,
        },
        step: step!,
        attempt: { ...attempt, checkpointDigest, providerCheckpoint },
        inputValue: {
          schemaVersion: "crewon.workflow-execution-value.v0" as const,
          ...inputValue,
          value: structuredClone(
            inputValue.value,
          ) as WorkflowExecutionValue["value"],
        },
        dispatch: { ...dispatch, status: "responseObserved" as const },
        priorContinuation: checkpoint,
      },
      handoff: {
        currentWorkItem: "retained" as const,
        nextWorkItemId: null,
        kind: "none" as const,
      },
      runDisposition: "nonTerminal" as const,
    });
  }
  if (checkpoint!.authority.attempt.attemptId !== attempt.attemptId)
    throw new RunStoreError("workflow_terminal_candidate_corrupt");
  if (run.rows[0]?.state_json.cancelRequested !== true)
    return settlePostgresRetrievedWorkflowNode(
      client,
      schema,
      {
        ...input,
        agentVersionId: node.agentVersionId!,
        attempt: {
          stepId: input.nodeId,
          attemptId: attempt.attemptId,
          workItemId: attempt.workItemId,
          leaseEpoch: attempt.leaseEpoch,
        },
        dispatch: {
          operationId: dispatch.operationId,
          requestSequence: dispatch.requestSequence,
          expectedRevision: dispatch.revision,
          status: "responseObserved",
        },
        evidence: candidate.evidence,
        dispatchTerminalOutcome: candidate.dispatchTerminalOutcome,
      },
      digester,
    );
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
  const next = await settleCanceledReconciliation(
    client,
    schema,
    input,
    execution,
    attempt,
    dispatch.responseCheckpointDigest,
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

export async function resumePostgresWorkflowExecution(
  client: PoolClient,
  schema: string,
  execution: Result["execution"],
  nodeId: string,
  leaseExpiresAt: string,
  now: string,
): Promise<Result["execution"]> {
  const current = execution.nodes.find((node) => node.nodeId === nodeId);
  if (current?.status === "running") return execution;
  if (current?.status !== "unknown")
    throw new RunStoreError("workflow_reconciliation_evidence_corrupt");
  const next = {
    ...execution,
    revision: execution.revision + 1,
    nodes: execution.nodes.map((node) =>
      node.nodeId === nodeId
        ? { ...node, status: "running" as const, leaseExpiresAt }
        : node,
    ),
    updatedAt: now,
  };
  await writePostgresWorkflowExecution(client, schema, next, now);
  return next;
}

export function resumeRequiredResult(
  input: Input,
  execution: Result["execution"],
  definition: WorkflowNodeDefinition,
  inputDigest: string,
  step: NonNullable<Awaited<ReturnType<typeof loadPostgresRunStep>>>,
  resumed: Awaited<ReturnType<typeof takeOverPostgresWorkflowContinuation>>,
  pendingTools: Awaited<ReturnType<typeof adoptPostgresWorkflowPendingTools>>,
): Extract<Result, { disposition: "resumeRequired" }> {
  return structuredClone({
    disposition: "resumeRequired" as const,
    evidenceStatus: "responseObserved" as const,
    resume: {
      claim: {
        node: definition,
        claimId: input.claimId,
        claimEpoch: input.claimEpoch,
        gateRequestId: null,
        inputDigest,
      },
      step,
      attempt: resumed.attempt,
      reconciliationLease: input.lease,
      continuation: resumed.continuation,
      pendingTools,
    },
    execution,
    handoff: {
      currentWorkItem: "retained" as const,
      nextWorkItemId: null,
      kind: "none" as const,
    },
    runDisposition: "nonTerminal" as const,
  });
}

async function settleCanceledReconciliation(
  client: PoolClient,
  schema: string,
  input: Input,
  execution: Result["execution"],
  attempt: NonNullable<Awaited<ReturnType<typeof loadPostgresRunAttempt>>>,
  checkpointDigest: string | null,
  now: string,
  digester: WorkflowContentDigester,
): Promise<Result["execution"]> {
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
      checkpointDigest,
    },
  });
  await appendPostgresCanceledWorkflowNodeEvent(
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
      operationId: `reconcile:${input.reconciliationOperationId}:${input.nodeId}`,
    },
    now,
    digester,
  );
  const nodes = execution.nodes.map((node) =>
    node.nodeId === input.nodeId
      ? {
          ...node,
          status: "canceled" as const,
          leaseExpiresAt: null,
          resultDigest: null,
          failureCode: null,
        }
      : node,
  );
  const next = {
    ...execution,
    revision: execution.revision + 1,
    nodes,
    status: nodes.some((node) =>
      ["queued", "running", "unknown"].includes(node.status),
    )
      ? ("running" as const)
      : nodes.some((node) => node.status === "waitingHuman")
        ? ("waitingHuman" as const)
        : ("canceled" as const),
    updatedAt: now,
  };
  await writePostgresWorkflowExecution(client, schema, next, now);
  return next;
}
