import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  RunStoreError,
  type WorkflowExecutionState,
  type WorkflowRunCompositionStore,
  type WorkflowRunDisposition,
} from "@crewon/application";
import {
  validateWorkflowSchemaValue,
  type CompiledWorkflowVersion,
  type RunState,
  type WorkflowContentDigester,
} from "@crewon/domain";

import {
  finishSqliteRunAttempt,
  loadSqliteRunAttempt,
  loadSqliteRunStep,
} from "./sqlite-execution-authority.ts";
import {
  settleWorkflowClaim,
  workflowAuthorityId,
} from "./workflow-run-composition-support.ts";

type Input = Parameters<WorkflowRunCompositionStore["settleWorkflowNode"]>[0];
export type SqliteWorkflowNodeSettlementResult = Awaited<
  ReturnType<WorkflowRunCompositionStore["settleWorkflowNode"]>
>;

export type SqliteWorkflowNodeSettlementContext = Readonly<{
  database: DatabaseSync;
  digester: WorkflowContentDigester;
  receipt(input: Input, kind: string, fingerprint: string): unknown | null;
  validateTerminalReplay(input: Input, replay: unknown): void;
  validateNodeTerminalReplay(input: Input): void;
  validateLease(input: Input, nowMs: number): void;
  assertCanonicalRun(run: RunState | null, binding: Input["binding"]): void;
  loadRun(tenantId: string, runId: string): RunState | null;
  loadExecution(tenantId: string, runId: string): WorkflowExecutionState | null;
  loadWorkflow(input: Input): CompiledWorkflowVersion;
  insertExecutionValue(input: {
    tenantId: string; runId: string; valueId: string; role: string;
    nodeId: string | null; valueDigest: string; valueJson: string; now: string;
  }): void;
  appendNodeTerminalEvent(input: Input, resultDigest: string | null,
    now: string, nowMs: number): void;
  writeExecution(execution: WorkflowExecutionState, now: string): void;
  convergeTerminalRun(
    input: Input,
    workflow: CompiledWorkflowVersion,
    execution: WorkflowExecutionState,
    now: string,
    nowMs: number,
  ): WorkflowRunDisposition;
  insertWorkflowWorkItem(
    workItemId: string,
    input: Input,
    payload: Record<string, unknown>,
    now: string,
    nowMs: number,
  ): void;
  rootInputRef(input: Input): { valueId: string; valueDigest: string };
  insertReceipt(input: Input, kind: string, fingerprint: string, result: unknown): void;
  completeLease(input: Input, nowMs: number): void;
}>;

/** Executes ordinary node settlement inside an already-open SQLite transaction. */
export function settleSqliteWorkflowNodeWithinTransaction<Result = SqliteWorkflowNodeSettlementResult>(
  context: SqliteWorkflowNodeSettlementContext,
  input: Input,
  fingerprint: string,
  now: string,
  nowMs: number,
  options: Readonly<{
    attemptCheckpointDigest?: string | null;
    attemptAuthority?: Readonly<{ workItemId: string; leaseEpoch: number }>;
    beforeReceipt?(result: SqliteWorkflowNodeSettlementResult): void;
    mapResult?(result: SqliteWorkflowNodeSettlementResult): Result;
  }> = {},
): Result {
  const replay = context.receipt(input, "settleNode", fingerprint);
  if (replay !== null) {
    context.validateTerminalReplay(input, replay);
    context.validateNodeTerminalReplay(input);
    return structuredClone({
      ...(replay as object),
      disposition: "replay",
    } as Result);
  }
  context.validateLease(input, nowMs);
  context.assertCanonicalRun(
    context.loadRun(input.tenantId, input.runId),
    input.binding,
  );
  const execution = context.loadExecution(input.tenantId, input.runId);
  const step = loadSqliteRunStep(context.database, input);
  const attempt = loadSqliteRunAttempt(context.database, input);
  const attemptAuthority = options.attemptAuthority ?? input.lease;
  if (
    execution === null ||
    step === null ||
    attempt === null ||
    input.stepId !== input.nodeId ||
    step.currentAttemptId !== input.attemptId ||
    attempt.workItemId !== attemptAuthority.workItemId ||
    attempt.leaseEpoch !== attemptAuthority.leaseEpoch
  )
    throw new RunStoreError("workflow_composition_attempt_mismatch");
  const workflow = context.loadWorkflow(input);
  const definition = workflow.nodes.find((node) => node.nodeId === input.nodeId);
  if (definition === undefined)
    throw new RunStoreError("workflow_composition_claim_mismatch");
  let resultDigest: string | undefined;
  if (input.outcome.status === "completed") {
    const value = validateWorkflowSchemaValue(input.outcome.value, definition.outputSchema);
    const valueJson = canonicalJson(value);
    resultDigest = context.digester.sha256(valueJson);
    const valueId = workflowAuthorityId("value", {
      tenantId: input.tenantId, runId: input.runId, nodeId: input.nodeId,
      claimId: input.claimId, claimEpoch: input.claimEpoch, resultDigest,
    }, context.digester);
    context.insertExecutionValue({ ...input, valueId, role: "nodeOutput",
      nodeId: input.nodeId, valueDigest: resultDigest, valueJson, now });
  }
  const next = settleWorkflowClaim({ execution, ...input, resultDigest, now });
  if (input.outcome.status !== "unknown") {
    context.appendNodeTerminalEvent(input, resultDigest ?? null, now, nowMs);
    finishSqliteRunAttempt(context.database, {
      tenantId: input.tenantId,
      runId: input.runId,
      workItemId: attemptAuthority.workItemId,
      leaseEpoch: attemptAuthority.leaseEpoch,
      attempt: terminalAttempt(
        input,
        now,
        options.attemptCheckpointDigest ?? null,
      ),
    });
  }
  context.writeExecution(next, now);
  const runDisposition = context.convergeTerminalRun(input, workflow, next, now, nowMs);
  let schedulerContinuationWorkItemId: string | null = null;
  let reconciliationWorkItemId: string | null = null;
  if (input.outcome.status === "unknown") {
    reconciliationWorkItemId = workflowAuthorityId(
      "reconcile",
      { tenantId: input.tenantId, runId: input.runId, binding: input.binding,
        operationId: input.operationId, nodeId: input.nodeId,
        claimId: input.claimId, claimEpoch: input.claimEpoch },
      context.digester,
    );
    context.insertWorkflowWorkItem(reconciliationWorkItemId, input, {
      schemaVersion: "crewon.workflow-reconcile-work-item.v0",
      trigger: "workflowReconcile", binding: input.binding,
      nodeId: input.nodeId, claimId: input.claimId,
      claimEpoch: input.claimEpoch,
      reconciliationOperationId: input.operationId,
    }, now, nowMs);
  } else if (
    !next.nodes.some((node) =>
      ["queued", "running", "unknown", "waitingHuman"].includes(node.status),
    ) &&
    next.status === "running"
  ) {
    schedulerContinuationWorkItemId = workflowAuthorityId(
      "scheduler",
      { tenantId: input.tenantId, runId: input.runId, binding: input.binding,
        settledNodeId: input.nodeId, claimId: input.claimId,
        claimEpoch: input.claimEpoch },
      context.digester,
    );
    context.insertWorkflowWorkItem(
      schedulerContinuationWorkItemId,
      input,
      {
        schemaVersion: "crewon.workflow-scheduler-work-item.v1",
        trigger: "workflowScheduler",
        binding: input.binding,
        schedulerOperationId: schedulerContinuationWorkItemId,
        workflowInput: context.rootInputRef(input),
      },
      now,
      nowMs,
    );
  }
  const result = {
    disposition:
      input.outcome.status === "unknown"
        ? ("reconciliationScheduled" as const)
        : ("settled" as const),
    execution: next,
    schedulerContinuationWorkItemId,
    handoff: {
      currentWorkItem: "completed" as const,
      nextWorkItemId: reconciliationWorkItemId ?? schedulerContinuationWorkItemId,
      kind: reconciliationWorkItemId !== null
        ? "reconcile" as const
        : schedulerContinuationWorkItemId === null ? "none" as const : "scheduler" as const,
    },
    runDisposition,
  };
  options.beforeReceipt?.(result);
  const returned = options.mapResult?.(result) ?? result as Result;
  context.insertReceipt(input, "settleNode", fingerprint, returned);
  context.completeLease(input, nowMs);
  return structuredClone(returned);
}

function terminalAttempt(input: Input, now: string, checkpointDigest: string | null) {
  const common = {
    stepId: input.stepId,
    attemptId: input.attemptId,
    finishedAt: now,
    checkpointDigest,
  };
  switch (input.outcome.status) {
    case "completed":
      return { ...common, status: "completed" as const };
    case "failed":
      return {
        ...common,
        status: "failed" as const,
        failure: { code: input.outcome.failureCode, retryable: false },
      };
    case "canceled":
      return { ...common, status: "canceled" as const };
    case "unknown":
      throw new RunStoreError("workflow_composition_unknown_not_terminal");
  }
}
