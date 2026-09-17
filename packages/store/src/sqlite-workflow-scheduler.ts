import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  RunStoreError,
  type WorkflowSchedulerInput,
  type WorkflowSchedulerAuthorization,
  type WorkflowSchedulerPassResult,
  type WorkItem,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import { readSqliteWorkflowCompositionContext } from "./sqlite-workflow-composition-context.ts";
import { readSqliteWorkflowExecution } from "./sqlite-workflow-execution-authority.ts";
import {
  readSqliteWorkflowNodes,
  sqliteWorkflowNodeAdmission,
} from "./sqlite-workflow-node-authority.ts";
import { readSqliteWorkflowChildren } from "./sqlite-workflow-child-dispatch.ts";
import { readSqliteWorkflowChildWorkItem } from "./sqlite-workflow-child-cancellation.ts";
import { readSqliteWorkflowHumanGates } from "./sqlite-workflow-human-gate-authority.ts";
import {
  finalizeSqliteWorkflowRoot,
  type WorkflowRootOperations,
} from "./sqlite-workflow-root-finalization.ts";

type Operations = WorkflowRootOperations & { enqueue(work: WorkItem): void };
export type SqliteWorkflowSchedulerOptions = Readonly<{
  authorize: WorkflowSchedulerAuthorization;
  maximumParallelNodes: number;
  humanGatesEnabled: boolean;
  nextId(): string;
}>;

export function authorizeSqliteWorkflowScheduler(
  authorize: WorkflowSchedulerAuthorization,
  run: RunState,
  workItem: WorkItem,
): void {
  // No asynchronous callback or mutable copies of canonical authority may escape this boundary.
  const decision = authorize(structuredClone({ run, workItem }));
  if (decision?.outcome !== "allow")
    throw new RunStoreError("workflow_scheduler_policy_denied");
}

/** Caller owns BEGIN IMMEDIATE. Starts at most once and never creates a model Attempt. */
export function prepareSqliteWorkflowRun(
  db: DatabaseSync,
  input: WorkflowSchedulerInput,
  ops: Operations,
  options: SqliteWorkflowSchedulerOptions,
): RunState {
  ops.validateLease(input, ops.now());
  const run = readRoot(db, input, ops);
  const context = readSqliteWorkflowCompositionContext(db, { ...input, run });
  if (terminal(run.status) || run.cancelRequested) return run;
  if (run.status !== "queued" && run.status !== "running")
    throw new RunStoreError("workflow_root_state_invalid");
  authorizeSqliteWorkflowScheduler(options.authorize, run, context.workItem);
  if (run.status === "running") return run;
  const now = new Date(ops.now()).toISOString();
  const event = {
    schemaVersion: "crewon.run-event.v0" as const,
    identity: { runId: run.runId },
    eventId: options.nextId(),
    sequence: run.lastSequence + 1,
    occurredAt: now,
    type: "run.started" as const,
    data: {},
  };
  const result = ops.commitRootRun(
    {
      tenantId: run.tenantId,
      expectedRevision: run.revision,
      idempotency: {
        scope: canonicalJson({
          namespace: "workflow.scheduler-start.v1",
          tenantId: run.tenantId,
        }),
        key: run.runId,
        requestFingerprint: canonicalJson(run.workflowVersionBinding),
      },
      events: [event],
      workItems: [],
      outbox: [
        {
          messageId: options.nextId(),
          tenantId: run.tenantId,
          runId: run.runId,
          topic: "run.updated",
          payload: {
            eventId: event.eventId,
            eventType: event.type,
            throughSequence: event.sequence,
          },
          createdAt: now,
        },
      ],
    },
    input.lease,
  );
  if (result.disposition !== "committed")
    throw new RunStoreError("workflow_scheduler_start_conflict");
  ops.validateLease(input, ops.now());
  return result.state;
}

/** Caller owns BEGIN IMMEDIATE; no lifetime queue scan, polling timer or retained DAG. */
export function finishSqliteWorkflowSchedulerPass(
  db: DatabaseSync,
  input: WorkflowSchedulerInput,
  ops: Operations,
  options: SqliteWorkflowSchedulerOptions,
): WorkflowSchedulerPassResult {
  ops.validateLease(input, ops.now());
  const run = readRoot(db, input, ops);
  const context = readSqliteWorkflowCompositionContext(db, { ...input, run });
  const state = readSqliteWorkflowExecution(db, input);
  if (!state) throw new RunStoreError("workflow_execution_not_found");
  if (
    state.workflowId !== input.binding.workflowId ||
    state.workflowVersionId !== input.binding.workflowVersionId ||
    state.contentDigest !== input.binding.contentDigest
  )
    throw new RunStoreError("workflow_execution_binding_mismatch");
  const rows = readSqliteWorkflowNodes(db, state, context.workflow);
  for (const row of rows.values())
    sqliteWorkflowNodeAdmission(db, state, context.workflow, row);
  const children = readSqliteWorkflowChildren(db, state, run, ops.loadRun);
  if (
    !options.humanGatesEnabled &&
    state.nodes.some(
      (node) => node.kind === "humanGate" && node.claimId !== null,
    )
  )
    throw new RunStoreError("workflow_gate_unavailable");
  readSqliteWorkflowHumanGates(db, state, run, context, {
    requirePublishedGates: options.humanGatesEnabled,
  });
  let liveChildren = 0;
  let ready = run.cancelRequested !== state.cancelRequested;
  for (const node of state.nodes) {
    if (node.kind === "humanGate" || node.claimId === null) continue;
    const row = children.get(node.claimId);
    if (!row) throw new RunStoreError("workflow_child_handoff_missing");
    const child = ops.loadRun({
      tenantId: input.tenantId,
      runId: row.child_run_id,
    })!;
    if (terminal(child.status)) {
      // A child may finish between node admission and this acknowledgement transaction.
      if (!terminal(node.status)) ready = true;
    } else {
      if (terminal(node.status))
        throw new RunStoreError("workflow_child_terminal_conflict");
      readSqliteWorkflowChildWorkItem(db, run, child, row);
      liveChildren++;
    }
  }
  const humanGates = state.nodes.filter(
    (node) => node.status === "waitingHuman",
  ).length;
  if (
    terminal(run.status) ||
    (!ready && terminal(state.status) && liveChildren === 0 && humanGates === 0)
  ) {
    const result = finalizeSqliteWorkflowRoot(db, input, ops, {
      childrenEnabled: true,
      humanGatesEnabled: options.humanGatesEnabled,
      nextId: options.nextId,
    });
    return { kind: "terminal", run: result.run };
  }
  if (
    !run.cancelRequested &&
    state.status !== "failed" &&
    liveChildren < options.maximumParallelNodes
  ) {
    const completed = new Set(
      state.nodes
        .filter((node) => node.status === "completed")
        .map((node) => node.nodeId),
    );
    ready ||= state.nodes.some(
      (node) =>
        node.status === "pending" &&
        context.workflow.nodes
          .find((definition) => definition.nodeId === node.nodeId)!
          .dependsOn.every((id) => completed.has(id)),
    );
  }
  if (ready) {
    // Replaying a node-pass receipt cannot grant fresh admissions. A successor has a new
    // operation identity and shares the acknowledgement transaction, including crash recovery.
    ops.enqueue({
      ...context.workItem,
      workItemId: options.nextId(),
      createdAt: new Date(ops.now()).toISOString(),
      payload: {
        ...context.workItem.payload,
        schedulerOperationId: options.nextId(),
      },
    });
  } else if (liveChildren === 0 && humanGates === 0) {
    throw new RunStoreError("workflow_scheduler_wake_source_missing");
  }
  ops.validateLease(input, ops.now());
  ops.settleRootWork(input.lease, ops.now());
  return ready
    ? { kind: "ready", runId: run.runId }
    : { kind: "waiting", runId: run.runId, children: liveChildren, humanGates };
}

function readRoot(
  db: DatabaseSync,
  input: WorkflowSchedulerInput,
  ops: Operations,
): RunState {
  const bytes = db
    .prepare(
      "SELECT length(CAST(state_json AS BLOB)) AS n FROM run_snapshots WHERE tenant_id=? AND run_id=?",
    )
    .get(input.tenantId, input.runId);
  if (bytes && Number(bytes.n) > 16384)
    throw new RunStoreError("workflow_root_state_limit");
  const run = ops.loadRun(input);
  if (!run) throw new RunStoreError("run_not_found");
  if (run.goalBinding !== null || run.goalAccounting !== null)
    throw new RunStoreError("workflow_root_goal_unsupported");
  return run;
}
function terminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}
