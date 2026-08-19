import {
  RunStoreError,
  validateWorkflowNodeContinuationCheckpoint,
  type SettleWorkflowNodeModelTerminalInput,
  type WorkflowNodeContinuationStore,
} from "@crewon/application";
import {
  validateWorkflowDispatchTerminalCorrelation,
  validateWorkflowNodeTerminalEvidence,
} from "@crewon/domain";

import {
  loadSqliteRunAttempt,
  loadSqliteRunStep,
} from "./sqlite-execution-authority.ts";
import {
  loadSqliteModelDispatchReceipt,
  terminateSqliteModelDispatch,
  terminateSqliteModelDispatchForAttempt,
} from "./sqlite-model-dispatch-evidence.ts";
import {
  settleSqliteWorkflowNodeWithinTransaction,
  type SqliteWorkflowNodeSettlementContext,
  type SqliteWorkflowNodeSettlementResult,
} from "./sqlite-workflow-node-settlement.ts";
import { stableJson } from "./store-invariants.ts";
import { workflowAuthorityId } from "./workflow-run-composition-support.ts";

type Result = Awaited<
  ReturnType<WorkflowNodeContinuationStore["settleWorkflowNodeModelTerminal"]>
>;

export function settleSqliteWorkflowNodeModelTerminalWithinTransaction(
  context: SqliteWorkflowNodeSettlementContext,
  input: SettleWorkflowNodeModelTerminalInput,
  fingerprint: string,
  now: string,
  nowMs: number,
  source: "liveNode" | "reconciliation" = "liveNode",
  candidateId: string | null = null,
): Result {
  const settlement = ordinarySettlement(input);
  const replay = source === "liveNode"
    ? context.receipt(settlement, "settleNode", fingerprint) : null;
  if (replay !== null) {
    validateReplay(context, input, settlement, replay, candidateId);
    context.validateNodeTerminalReplay(settlement);
    return structuredClone({ ...(replay as Result), disposition: "replay" });
  }
  validateInputAuthority(context, input, source);
  const workflow = context.loadWorkflow(settlement);
  const evidence = validateWorkflowNodeTerminalEvidence({
    workflow,
    nodeId: input.nodeId,
    evidence: input.evidence,
    digester: context.digester,
  });
  validateWorkflowDispatchTerminalCorrelation({
    dispatch: input.dispatchTerminalOutcome,
    evidence,
  });
  const dispatch = loadDispatch(context, input);
  if (
    dispatch.revision !== input.dispatch.expectedRevision ||
    dispatch.status !== input.dispatch.status ||
    dispatch.provider.agentVersionId !== input.authority.agentVersionId
  ) mismatch();
  validateContinuation(
    context,
    input,
    dispatch.responseCheckpointDigest,
    source,
  );
  const terminalInput = {
    tenantId: input.authority.tenantId,
    runId: input.authority.runId,
    attempt: input.authority.attempt,
    operationId: input.dispatch.operationId,
    requestSequence: input.dispatch.requestSequence,
    expectedRevision: input.dispatch.expectedRevision,
    transitionedAt: now,
    outcome: input.dispatchTerminalOutcome,
  };
  const terminal = source === "liveNode"
    ? terminateSqliteModelDispatch(context.database, { ...terminalInput, lease: input.lease })
    : terminateSqliteModelDispatchForAttempt(context.database, { ...terminalInput,
        attemptWorkItemId: input.authority.workItemId,
        attemptLeaseEpoch: input.authority.leaseEpoch });
  if (terminal.terminalOutcome === null) mismatch();
  validateWorkflowDispatchTerminalCorrelation({
    dispatch: terminal.terminalOutcome,
    evidence,
  });
  return settleSqliteWorkflowNodeWithinTransaction<Result>(
    { ...context, receipt: () => null,
      ...(source === "reconciliation" ? { insertReceipt: () => undefined } : {}) },
    settlement,
    fingerprint,
    now,
    nowMs,
    {
      attemptCheckpointDigest: terminal.responseCheckpointDigest,
      attemptAuthority: { workItemId: input.authority.workItemId,
        leaseEpoch: input.authority.leaseEpoch },
      beforeReceipt: () => deleteContinuation(context, input),
      mapResult: (settled) => ({
        disposition: settled.disposition,
        continuation: null,
        handoff: settled.handoff,
        runDisposition: settled.runDisposition,
        evidence: structuredClone(evidence),
        ...(candidateId === null ? {} : { candidateId }),
      }),
    },
  );
}

function ordinarySettlement(input: SettleWorkflowNodeModelTerminalInput) {
  const evidence = input.evidence;
  return {
    tenantId: input.authority.tenantId,
    runId: input.authority.runId,
    lease: input.lease,
    binding: input.binding,
    nodeId: input.authority.nodeId,
    claimId: input.authority.claimId,
    claimEpoch: input.authority.claimEpoch,
    stepId: input.authority.attempt.stepId,
    attemptId: input.authority.attempt.attemptId,
    operationId: input.operationId,
    outcome: evidence.status === "completed"
      ? { status: "completed" as const, value: evidence.value }
      : evidence.status === "failed"
        ? { status: "failed" as const, failureCode: evidence.failureCode }
        : { status: "canceled" as const },
  };
}

function validateInputAuthority(
  context: SqliteWorkflowNodeSettlementContext,
  input: SettleWorkflowNodeModelTerminalInput,
  source: "liveNode" | "reconciliation",
): void {
  const authority = input.authority;
  if (
    input.nodeId !== authority.nodeId ||
    (source === "liveNode" &&
      (input.lease.workItemId !== authority.workItemId ||
       input.lease.leaseEpoch !== authority.leaseEpoch))
  ) mismatch();
  const execution = context.loadExecution(authority.tenantId, authority.runId);
  const node = execution?.nodes.find((candidate) => candidate.nodeId === authority.nodeId);
  const step = loadSqliteRunStep(context.database, {
    tenantId: authority.tenantId,
    runId: authority.runId,
    stepId: authority.attempt.stepId,
  });
  const attempt = loadSqliteRunAttempt(context.database, {
    tenantId: authority.tenantId,
    runId: authority.runId,
    ...authority.attempt,
  });
  if (node === undefined) mismatch();
  const reconciliationNodeAuthority = node.status === "unknown" ||
    (node.status === "running" &&
      input.lease.workItemId === authority.workItemId &&
      input.lease.leaseEpoch === authority.leaseEpoch);
  if (
    (source === "liveNode" ? node.status !== "running" : !reconciliationNodeAuthority) ||
    node.kind !== authority.nodeKind ||
    node.claimId !== authority.claimId ||
    node.claimEpoch !== authority.claimEpoch ||
    node.agentVersionId !== authority.agentVersionId ||
    step?.kind !== authority.nodeKind ||
    step.status !== "running" ||
    step.currentAttemptId !== authority.attempt.attemptId ||
    attempt?.status !== "running" ||
    attempt.workItemId !== authority.workItemId ||
    attempt.leaseEpoch !== authority.leaseEpoch
  ) mismatch();
  const row = context.database.prepare(
    "SELECT work_item_json FROM work_items WHERE work_item_id=?",
  ).get(authority.workItemId) as { work_item_json: string } | undefined;
  const item = row === undefined ? null : JSON.parse(row.work_item_json) as {
    payload?: unknown;
  };
  if (
    !validSettlementWorkItemPayload(
      context,
      input,
      node.claimOperationId,
      item?.payload,
    )
  ) mismatch();
}

function loadDispatch(
  context: SqliteWorkflowNodeSettlementContext,
  input: SettleWorkflowNodeModelTerminalInput,
) {
  const dispatch = loadSqliteModelDispatchReceipt(context.database, {
    tenantId: input.authority.tenantId,
    runId: input.authority.runId,
    ...input.authority.attempt,
    operationId: input.dispatch.operationId,
  });
  if (
    dispatch === null ||
    dispatch.requestSequence !== input.dispatch.requestSequence ||
    dispatch.workItemId !== input.authority.workItemId ||
    dispatch.leaseEpoch !== input.authority.leaseEpoch
  ) mismatch();
  return dispatch;
}

function deleteContinuation(
  context: SqliteWorkflowNodeSettlementContext,
  input: SettleWorkflowNodeModelTerminalInput,
): void {
  context.database.prepare(
    `DELETE FROM workflow_node_continuations
     WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?`,
  ).run(input.authority.tenantId, input.authority.runId,
    input.authority.attempt.stepId, input.authority.attempt.attemptId);
}

function validateContinuation(
  context: SqliteWorkflowNodeSettlementContext,
  input: SettleWorkflowNodeModelTerminalInput,
  checkpointDigest: string | null,
  source: "liveNode" | "reconciliation",
): void {
  const row = context.database.prepare(
    `SELECT checkpoint_json FROM workflow_node_continuations
     WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?`,
  ).get(input.authority.tenantId, input.authority.runId,
    input.authority.attempt.stepId, input.authority.attempt.attemptId) as
    { checkpoint_json: string } | undefined;
  if (row === undefined) return;
  try {
    const checkpoint = validateWorkflowNodeContinuationCheckpoint(
      JSON.parse(row.checkpoint_json),
    );
    const attempt = loadSqliteRunAttempt(context.database, {
      tenantId: input.authority.tenantId, runId: input.authority.runId,
      ...input.authority.attempt,
    });
    const resumedRetrieval = source === "reconciliation" &&
      input.authority.workItemId === input.lease.workItemId &&
      input.authority.leaseEpoch === input.lease.leaseEpoch &&
      checkpoint.activeDispatch === null && checkpoint.terminalCandidate === null &&
      input.dispatch.status === "responseObserved";
    const checkpointedDispatch = checkpoint.activeDispatch !== null &&
      checkpoint.activeDispatch.operationId === input.dispatch.operationId &&
      checkpoint.activeDispatch.requestSequence === input.dispatch.requestSequence &&
      checkpoint.activeDispatch.expectedRevision === input.dispatch.expectedRevision &&
      checkpoint.activeDispatch.status === input.dispatch.status &&
      (checkpointDigest === null ||
        checkpoint.activeDispatch.status === "responseObserved");
    if (stableJson(checkpoint.authority) !== stableJson(input.authority) ||
        attempt?.providerTurnState !== checkpoint.providerTurnState ||
        (!resumedRetrieval && !checkpointedDispatch)) mismatch();
  } catch (error) {
    if (error instanceof RunStoreError) throw error;
    mismatch();
  }
}

function validateReplay(
  context: SqliteWorkflowNodeSettlementContext,
  input: SettleWorkflowNodeModelTerminalInput,
  settlement: ReturnType<typeof ordinarySettlement>,
  replay: unknown,
  candidateId: string | null,
): void {
  try {
    const result = replay as Result;
    const workflow = context.loadWorkflow(settlement);
    const evidence = validateWorkflowNodeTerminalEvidence({
      workflow, nodeId: input.nodeId, evidence: result.evidence,
      digester: context.digester,
    });
    if (stableJson(evidence) !== stableJson(input.evidence) ||
        result.disposition !== "settled" || result.continuation !== null ||
        (candidateId !== null &&
          (result as Result & { candidateId?: unknown }).candidateId !== candidateId) ||
        stableJson(Object.keys(result).sort()) !== stableJson([
          ...(candidateId === null ? [] : ["candidateId"]), "continuation",
          "disposition", "evidence", "handoff", "runDisposition",
        ])) corrupt();
    validateWorkflowDispatchTerminalCorrelation({
      dispatch: input.dispatchTerminalOutcome,
      evidence,
    });
    const dispatch = loadDispatch(context, input);
    const attempt = loadSqliteRunAttempt(context.database, {
      tenantId: input.authority.tenantId, runId: input.authority.runId,
      ...input.authority.attempt,
    });
    const step = loadSqliteRunStep(context.database, {
      tenantId: input.authority.tenantId, runId: input.authority.runId,
      stepId: input.authority.attempt.stepId,
    });
    const execution = context.loadExecution(input.authority.tenantId, input.authority.runId);
    const node = execution?.nodes.find((candidate) => candidate.nodeId === input.nodeId);
    const continuation = context.database.prepare(
      `SELECT 1 FROM workflow_node_continuations
       WHERE tenant_id=? AND run_id=? AND step_id=? AND attempt_id=?`,
    ).get(input.authority.tenantId, input.authority.runId,
      input.authority.attempt.stepId, input.authority.attempt.attemptId);
    const work = context.database.prepare(
      `SELECT tenant_id,run_id,kind,work_item_json,status,lease_owner_id,
              lease_id,lease_expires_at_ms,completed_at_ms
       FROM work_items WHERE work_item_id=?`,
    ).get(input.authority.workItemId) as Record<string, unknown> | undefined;
    const expectedStatus = evidence.status;
    const expectedFailure = evidence.status === "failed"
      ? { code: evidence.failureCode, retryable: false }
      : null;
    const workItem = work === undefined ? null :
      JSON.parse(String(work.work_item_json)) as { payload?: unknown };
    const terminalExecution = execution !== null &&
      ["completed", "failed", "canceled"].includes(execution.status);
    if (
      dispatch.status !== "terminal" ||
      dispatch.revision !== input.dispatch.expectedRevision + 1 ||
      stableJson(dispatch.terminalOutcome) !== stableJson(input.dispatchTerminalOutcome) ||
      dispatch.provider.agentVersionId !== input.authority.agentVersionId ||
      attempt?.tenantId !== input.authority.tenantId ||
      attempt.runId !== input.authority.runId ||
      attempt.stepId !== input.authority.attempt.stepId ||
      attempt.attemptId !== input.authority.attempt.attemptId ||
      attempt.workItemId !== input.authority.workItemId ||
      attempt.leaseEpoch !== input.authority.leaseEpoch ||
      attempt?.status !== expectedStatus ||
      attempt.terminalAt !== dispatch.terminalAt ||
      attempt.updatedAt !== dispatch.terminalAt ||
      attempt.checkpointDigest !== dispatch.responseCheckpointDigest ||
      stableJson(attempt.failure) !== stableJson(expectedFailure) ||
      step?.tenantId !== input.authority.tenantId ||
      step.runId !== input.authority.runId ||
      step.stepId !== input.authority.attempt.stepId ||
      step.kind !== input.authority.nodeKind ||
      step.currentAttemptId !== input.authority.attempt.attemptId ||
      step?.status !== expectedStatus ||
      step.updatedAt !== dispatch.terminalAt ||
      step.terminalAt !== dispatch.terminalAt ||
      node?.status !== expectedStatus ||
      node.kind !== input.authority.nodeKind ||
      node.claimId !== input.authority.claimId ||
      node.claimEpoch !== input.authority.claimEpoch ||
      node.agentVersionId !== input.authority.agentVersionId ||
      (evidence.status === "completed" &&
        node.resultDigest !== evidence.valueRef.valueDigest) ||
      (evidence.status === "failed" &&
        node.failureCode !== evidence.failureCode) ||
      (evidence.status !== "completed" && node.resultDigest !== null) ||
      (evidence.status !== "failed" && node.failureCode !== null) ||
      execution?.updatedAt !== dispatch.terminalAt ||
      continuation !== undefined ||
      work?.tenant_id !== input.authority.tenantId ||
      work.run_id !== input.authority.runId || work.kind !== "run.execute" ||
      !validSettlementWorkItemPayload(
        context,
        input,
        node?.claimOperationId,
        workItem?.payload,
      ) ||
      work.status !== "completed" || work.lease_owner_id !== null ||
      work.lease_id !== null || work.lease_expires_at_ms !== null
      || work.completed_at_ms !== Date.parse(dispatch.terminalAt!) ||
      result.runDisposition !==
        (terminalExecution ? "terminalConverged" : "nonTerminal")
    ) corrupt();
    validateHandoff(context, input, settlement, result, execution!);
    context.validateTerminalReplay(settlement, {
      runDisposition: result.runDisposition,
      execution,
    });
  } catch (error) {
    if (error instanceof RunStoreError &&
        error.code === "workflow_model_settlement_corrupt") throw error;
    throw new RunStoreError("workflow_model_settlement_corrupt", {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

function validateHandoff(
  context: SqliteWorkflowNodeSettlementContext,
  input: SettleWorkflowNodeModelTerminalInput,
  settlement: ReturnType<typeof ordinarySettlement>,
  result: Result,
  execution: NonNullable<ReturnType<SqliteWorkflowNodeSettlementContext["loadExecution"]>>,
): void {
  const needsScheduler = execution.status === "running" &&
    !execution.nodes.some((node) =>
      ["queued", "running", "unknown", "waitingHuman"].includes(node.status));
  const schedulerId = needsScheduler
    ? workflowAuthorityId("scheduler", {
        tenantId: settlement.tenantId, runId: settlement.runId,
        binding: settlement.binding, settledNodeId: settlement.nodeId,
        claimId: settlement.claimId, claimEpoch: settlement.claimEpoch,
      }, context.digester)
    : null;
  if (stableJson(result.handoff) !== stableJson({
    currentWorkItem: "completed",
    nextWorkItemId: schedulerId,
    kind: schedulerId === null ? "none" : "scheduler",
  })) corrupt();
  if (schedulerId !== null) {
    const row = context.database.prepare(
      "SELECT status,work_item_json FROM work_items WHERE work_item_id=?",
    ).get(schedulerId) as { status: string; work_item_json: string } | undefined;
    const item = row === undefined ? null : JSON.parse(row.work_item_json) as {
      tenantId?: unknown; runId?: unknown; payload?: Record<string, unknown> };
    const expectedPayload = {
      schemaVersion: "crewon.workflow-scheduler-work-item.v1",
      trigger: "workflowScheduler",
      binding: input.binding,
      schedulerOperationId: schedulerId,
      workflowInput: context.rootInputRef(settlement),
    };
    if (row?.status !== "pending" || item?.tenantId !== input.authority.tenantId ||
        item.runId !== input.authority.runId ||
        stableJson(item.payload) !== stableJson(expectedPayload)) corrupt();
  }
  const pendingSchedulers = context.database.prepare(
    `SELECT work_item_id FROM work_items
     WHERE tenant_id=? AND run_id=? AND status='pending'
       AND json_extract(work_item_json,'$.payload.trigger')='workflowScheduler'`,
  ).all(input.authority.tenantId, input.authority.runId) as
    { work_item_id: string }[];
  if (stableJson(pendingSchedulers.map((row) => row.work_item_id).sort()) !==
      stableJson(schedulerId === null ? [] : [schedulerId])) corrupt();
}

function validSettlementWorkItemPayload(
  context: SqliteWorkflowNodeSettlementContext,
  input: SettleWorkflowNodeModelTerminalInput,
  schedulerOperationId: string | null | undefined,
  value: unknown,
): boolean {
  const authority = input.authority;
  const nodePayload = {
    schemaVersion: "crewon.workflow-node-work-item.v0",
    trigger: "workflowNode",
    binding: input.binding,
    nodeId: authority.nodeId,
    claimId: authority.claimId,
    claimEpoch: authority.claimEpoch,
    schedulerOperationId,
  };
  if (stableJson(value) === stableJson(nodePayload)) return true;
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  if (
    authority.workItemId === input.lease.workItemId &&
    authority.leaseEpoch === input.lease.leaseEpoch &&
    stableJson(Object.keys(payload).sort()) === stableJson([
      "binding", "claimEpoch", "claimId", "nodeId",
      "reconciliationOperationId", "schemaVersion", "trigger",
    ]) &&
    payload.schemaVersion === "crewon.workflow-reconcile-work-item.v0" &&
    payload.trigger === "workflowReconcile" &&
    stableJson(payload.binding) === stableJson(input.binding) &&
    payload.nodeId === authority.nodeId &&
    payload.claimId === authority.claimId &&
    payload.claimEpoch === authority.claimEpoch &&
    typeof payload.reconciliationOperationId === "string" &&
    payload.reconciliationOperationId.length > 0
  ) return true;
  const handoff = context.database
    .prepare(
      `SELECT approval_id,action_digest,receipt_id,node_id,claim_id,claim_epoch,
              step_id,attempt_id,agent_work_item_id
       FROM workflow_tool_approval_handoffs
       WHERE tenant_id=? AND run_id=? AND resume_work_item_id=?
         AND consumption_operation_id IS NOT NULL`,
    )
    .get(authority.tenantId, authority.runId, authority.workItemId) as
    | Record<string, unknown>
    | undefined;
  return (
    handoff !== undefined &&
    stableJson(Object.keys(payload).sort()) ===
      stableJson([
        "actionDigest",
        "agentLeaseEpoch",
        "agentVersionId",
        "agentWorkItemId",
        "approvalId",
        "attemptId",
        "binding",
        "claimEpoch",
        "claimId",
        "nodeId",
        "receiptId",
        "schemaVersion",
        "stepId",
        "trigger",
      ]) &&
    payload.schemaVersion ===
      "crewon.workflow-tool-approval-resume-work-item.v0" &&
    payload.trigger === "workflowToolApprovalResume" &&
    stableJson(payload.binding) === stableJson(input.binding) &&
    payload.nodeId === authority.nodeId &&
    payload.claimId === authority.claimId &&
    payload.claimEpoch === authority.claimEpoch &&
    payload.stepId === authority.attempt.stepId &&
    payload.attemptId === authority.attempt.attemptId &&
    payload.agentVersionId === authority.agentVersionId &&
    payload.agentWorkItemId === handoff.agent_work_item_id &&
    Number.isSafeInteger(payload.agentLeaseEpoch) &&
    Number(payload.agentLeaseEpoch) >= 1 &&
    payload.approvalId === handoff.approval_id &&
    payload.receiptId === handoff.receipt_id &&
    payload.actionDigest === handoff.action_digest &&
    handoff.node_id === authority.nodeId &&
    handoff.claim_id === authority.claimId &&
    handoff.claim_epoch === authority.claimEpoch &&
    handoff.step_id === authority.attempt.stepId &&
    handoff.attempt_id === authority.attempt.attemptId
  );
}

function mismatch(): never {
  throw new RunStoreError("workflow_model_dispatch_mismatch");
}

function corrupt(): never {
  throw new RunStoreError("workflow_model_settlement_corrupt");
}
