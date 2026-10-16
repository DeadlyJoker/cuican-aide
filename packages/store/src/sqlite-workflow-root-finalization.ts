import {
  workflowRootOutcome,
  workflowRootFinalizationKey,
  prepareWorkflowRootCompletion,
} from "./workflow-root-result.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  RunStoreError,
  type CommitRunInput,
  type CommitRunResult,
  type CommitThreadInput,
  type CommitThreadResult,
  type RunLocator,
  type ThreadLocator,
  type WorkItemLeaseInput,
  type WorkflowRunFinalizationStore,
} from "@crewon/application";
import { type RunState, type ThreadState } from "@crewon/domain";
import { readSqliteWorkflowCompositionContext } from "./sqlite-workflow-composition-context.ts";
import { readSqliteWorkflowExecution } from "./sqlite-workflow-execution-authority.ts";
import {
  readSqliteWorkflowNodes,
  sqliteWorkflowNodeAdmission,
} from "./sqlite-workflow-node-authority.ts";
import { readSqliteWorkflowChildren } from "./sqlite-workflow-child-dispatch.ts";
import { readSqliteWorkflowRunOutput } from "./sqlite-workflow-run-output.ts";
import { readSqliteWorkflowHumanGates } from "./sqlite-workflow-human-gate-authority.ts";

export type WorkflowRootOperations = {
  loadRun(input: RunLocator): RunState | null;
  loadRootThread(input: ThreadLocator): ThreadState | null;
  commitRootThread(input: CommitThreadInput): CommitThreadResult;
  commitRootRun(
    input: CommitRunInput,
    lease: WorkItemLeaseInput,
  ): CommitRunResult;
  settleRootWork(lease: WorkItemLeaseInput, now: number): void;
  validateLease(
    input: RunLocator & { lease: WorkItemLeaseInput },
    now: number,
  ): number;
  now(): number;
};
type Input = Parameters<WorkflowRunFinalizationStore["finalizeWorkflowRun"]>[0];

/** Caller owns BEGIN IMMEDIATE. No model sample or scan of accumulated conversation history. */
export function finalizeSqliteWorkflowRoot(
  db: DatabaseSync,
  input: Input,
  ops: WorkflowRootOperations,
  options: {
    childrenEnabled: boolean;
    humanGatesEnabled: boolean;
    nextId(): string;
  },
): { disposition: "committed" | "replayed"; run: RunState } {
  const rootSize = db
    .prepare(
      "SELECT length(CAST(state_json AS BLOB)) AS n FROM run_snapshots WHERE tenant_id=? AND run_id=?",
    )
    .get(input.tenantId, input.runId);
  if (rootSize && Number(rootSize.n) > 16384)
    throw new RunStoreError("workflow_root_state_limit");
  const run = ops.loadRun(input);
  if (!run) throw new RunStoreError("run_not_found");
  const context = readSqliteWorkflowCompositionContext(db, { ...input, run });
  const execution = readSqliteWorkflowExecution(db, input);
  if (!execution) throw new RunStoreError("workflow_execution_not_found");
  if (
    execution.contentDigest !== input.binding.contentDigest ||
    execution.workflowVersionId !== input.binding.workflowVersionId ||
    execution.workflowId !== input.binding.workflowId
  )
    throw new RunStoreError("workflow_execution_binding_mismatch");
  const canceled =
    run.cancelRequested &&
    execution.cancelRequested &&
    execution.status === "canceled";
  if ((run.cancelRequested || execution.cancelRequested) && !canceled)
    throw new RunStoreError("workflow_cancellation_recovery_required");
  if (run.goalBinding !== null || run.goalAccounting !== null)
    throw new RunStoreError("workflow_root_goal_unsupported");
  const children = readSqliteWorkflowChildren(db, execution, run, ops.loadRun);
  if (children.size && !options.childrenEnabled)
    throw new RunStoreError("workflow_child_dispatch_unavailable");
  if (
    options.childrenEnabled &&
    execution.nodes.some(
      (n) =>
        n.kind !== "humanGate" &&
        n.claimId !== null &&
        !children.has(n.claimId),
    )
  )
    throw new RunStoreError("workflow_child_handoff_missing");
  if (
    options.childrenEnabled &&
    execution.nodes.some((n) => n.kind === "humanGate" && n.claimId !== null) &&
    !options.humanGatesEnabled
  )
    throw new RunStoreError("workflow_gate_unavailable");
  readSqliteWorkflowHumanGates(db, execution, run, context, {
    requirePublishedGates: options.humanGatesEnabled,
  });
  const rows = readSqliteWorkflowNodes(db, execution, context.workflow);
  for (const row of rows.values())
    sqliteWorkflowNodeAdmission(db, execution, context.workflow, row);
  const stepIds = new Set([...rows.values()].map((row) => row.step_id));
  const steps = db
    .prepare(
      "SELECT step_id FROM run_steps WHERE tenant_id=? AND run_id=? LIMIT 65",
    )
    .all(input.tenantId, input.runId);
  if (
    steps.length !== stepIds.size ||
    steps.some((row) => !stepIds.has(String(row.step_id)))
  )
    throw new RunStoreError("workflow_root_step_authority_conflict");
  if (
    (execution.status !== "completed" &&
      execution.status !== "failed" &&
      !canceled) ||
    execution.nodes.some(
      (n) =>
        n.status === "running" ||
        n.status === "unknown" ||
        n.status === "waitingHuman",
    )
  )
    throw new RunStoreError("workflow_finalization_pending");
  for (const child of children.values()) {
    const state = ops.loadRun({
      tenantId: input.tenantId,
      runId: child.child_run_id,
    })!;
    if (!["completed", "failed", "canceled"].includes(state.status))
      throw new RunStoreError("workflow_finalization_pending");
  }
  const { output, failureCode } = workflowRootOutcome({
    execution,
    workflow: context.workflow,
    rows,
  });
  const idempotency = workflowRootFinalizationKey({
    ...input,
    execution,
    output,
    failureCode,
    canceled,
  });
  const prior = db
    .prepare(
      `SELECT tenant_id,run_id,
    CASE WHEN length(CAST(fingerprint AS BLOB))<=128 THEN fingerprint ELSE NULL END AS fingerprint,
    CASE WHEN length(CAST(result_json AS BLOB))<=16384 THEN result_json ELSE NULL END AS result_json
    FROM idempotency_receipts WHERE scope=? AND idempotency_key=?`,
    )
    .get(idempotency.scope, idempotency.key);
  if (prior) {
    if (
      prior.tenant_id !== input.tenantId ||
      prior.run_id !== input.runId ||
      prior.fingerprint !== idempotency.requestFingerprint ||
      typeof prior.result_json !== "string"
    )
      corrupt();
    const result = JSON.parse(prior.result_json) as CommitRunResult;
    if (
      canonicalJson(result.state) !== canonicalJson(run) ||
      run.status !==
        (canceled ? "canceled" : output ? "completed" : "failed") ||
      !Array.isArray(result.events) ||
      result.events.length !== (output ? 2 : 1) ||
      !Array.isArray(result.workItems) ||
      result.workItems.length !== 0
    )
      corrupt();
    const actual = db
      .prepare(
        `SELECT CASE WHEN length(CAST(event_json AS BLOB))<=16384 THEN event_json ELSE NULL END AS json
      FROM run_events WHERE tenant_id=? AND run_id=? AND sequence>? ORDER BY sequence LIMIT 3`,
      )
      .all(
        input.tenantId,
        input.runId,
        run.lastSequence - result.events.length,
      );
    if (
      actual.some((row) => row.json === null) ||
      canonicalJson(actual.map((row) => JSON.parse(String(row.json)))) !==
        canonicalJson(result.events)
    )
      corrupt();
    if (output && readSqliteWorkflowRunOutput(db, run) !== output.json)
      corrupt();
    if (
      !output &&
      !canceled &&
      (run.failure?.code !== failureCode || run.failure.retryable)
    )
      corrupt();
    const work = db
      .prepare("SELECT status FROM work_items WHERE work_item_id=?")
      .get(input.lease.workItemId);
    if (work?.status !== "completed") {
      ops.validateLease(input, ops.now());
      ops.settleRootWork(input.lease, ops.now());
    }
    return { disposition: "replayed", run };
  }
  ops.validateLease(input, ops.now());
  if (run.status !== "running" && !(canceled && run.status === "queued"))
    throw new RunStoreError("workflow_root_terminal_authority_missing");
  const now = new Date(ops.now()).toISOString();
  let thread: ThreadState | null = null,
    historyHead = 0;
  if (output) {
    const size = db
      .prepare(
        "SELECT length(CAST(state_json AS BLOB)) AS n FROM threads WHERE tenant_id=? AND thread_id=?",
      )
      .get(run.tenantId, run.threadId);
    if (size && Number(size.n) > 65536)
      throw new RunStoreError("workflow_root_thread_limit");
    thread = ops.loadRootThread({
      tenantId: run.tenantId,
      threadId: run.threadId,
    });
    if (!thread || thread.spaceId !== run.spaceId)
      throw new RunStoreError("thread_not_found");
    const head = db
      .prepare(
        "SELECT COALESCE(MAX(sequence),0) AS n FROM model_history_items WHERE tenant_id=? AND thread_id=?",
      )
      .get(run.tenantId, run.threadId)!;
    historyHead = Number(head.n);
  }
  const prepared = prepareWorkflowRootCompletion({
    run,
    thread,
    historyHead,
    output,
    failureCode,
    canceled,
    idempotency,
    now,
    nextId: options.nextId,
  });
  if (
    prepared.thread &&
    ops.commitRootThread(prepared.thread).disposition !== "committed"
  )
    throw new RunStoreError("workflow_root_terminal_authority_missing");
  const result = ops.commitRootRun(prepared.commit, input.lease);
  if (result.disposition !== "committed") corrupt();
  if (Buffer.byteLength(canonicalJson(result)) > 16384)
    throw new RunStoreError("workflow_root_receipt_limit");
  ops.validateLease(input, ops.now());
  ops.settleRootWork(input.lease, ops.now());
  return { disposition: "committed", run: result.state };
}
function corrupt(): never {
  throw new RunStoreError("workflow_root_receipt_corrupt");
}
