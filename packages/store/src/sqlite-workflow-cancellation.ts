import { cancelSqliteWorkflowUnstartedNodes } from "./sqlite-workflow-unstarted-cancellation.ts";
import {
  commitSqliteWorkflowChildCancellation,
  readSqliteWorkflowChildWorkItem,
  wakeSqliteWorkflowChildCancellation,
} from "./sqlite-workflow-child-cancellation.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  initialWorkflowExecution,
  projectWorkflowExecution,
  RunStoreError,
  type WorkflowRunCancellationStore,
} from "@crewon/application";
import type { RunState, RunLifecycleEvent } from "@crewon/domain";
import type { WorkflowRootOperations } from "./sqlite-workflow-root-finalization.ts";
import { readSqliteWorkflowCompositionContext } from "./sqlite-workflow-composition-context.ts";
import {
  readSqliteWorkflowExecution,
  writeSqliteWorkflowExecution,
} from "./sqlite-workflow-execution-authority.ts";
import {
  readSqliteWorkflowNodes,
  sqliteWorkflowNodeAdmission,
} from "./sqlite-workflow-node-authority.ts";
import {
  readSqliteWorkflowChildren,
  type WorkflowChildOperations,
  type WorkflowChildRow,
} from "./sqlite-workflow-child-dispatch.ts";
import { reconcileSqliteWorkflowChildren } from "./sqlite-workflow-child-reconciliation.ts";
import { assertSqliteWorkflowCancellationSchema } from "./sqlite-workflow-cancellation-schema.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";
import { readSqliteWorkflowHumanGates } from "./sqlite-workflow-human-gate-authority.ts";

type Input = Parameters<
  WorkflowRunCancellationStore["propagateWorkflowCancellation"]
>[0];
/** Caller holds one scheduler lease and BEGIN IMMEDIATE for the whole bounded DAG. */
export function propagateSqliteWorkflowCancellation(
  db: DatabaseSync,
  input: Input,
  ops: WorkflowRootOperations & WorkflowChildOperations,
  options: {
    childrenEnabled: boolean;
    humanGatesEnabled: boolean;
    nextId(): string;
  },
) {
  ops.validateLease(input, ops.now());
  const bytes = db
    .prepare(
      "SELECT length(CAST(state_json AS BLOB)) AS n FROM run_snapshots WHERE tenant_id=? AND run_id=?",
    )
    .get(input.tenantId, input.runId);
  if (bytes && Number(bytes.n) > 16384)
    throw new RunStoreError("workflow_root_state_limit");
  const run = ops.loadRun(input);
  if (
    !run ||
    !run.cancelRequested ||
    !["queued", "running"].includes(run.status)
  )
    throw new RunStoreError("workflow_root_cancellation_required");
  const context = readSqliteWorkflowCompositionContext(db, { ...input, run });
  const request = cancellationRequest(db, run);
  const now = new Date(ops.now()).toISOString();
  let current = readSqliteWorkflowExecution(db, input);
  if (current === null) {
    current = initialWorkflowExecution({
      ...input,
      workflow: context.workflow,
      now,
    });
    writeSqliteWorkflowExecution(db, null, current);
  }
  if (
    current.workflowId !== input.binding.workflowId ||
    current.workflowVersionId !== input.binding.workflowVersionId ||
    current.contentDigest !== input.binding.contentDigest
  )
    throw new RunStoreError("workflow_execution_binding_mismatch");
  const children = readSqliteWorkflowChildren(db, current, run, ops.loadRun);
  if (children.size && !options.childrenEnabled)
    throw new RunStoreError("workflow_child_dispatch_unavailable");
  if (
    options.childrenEnabled &&
    current.nodes.some(
      (node) =>
        node.kind !== "humanGate" &&
        node.claimId !== null &&
        !children.has(node.claimId),
    )
  )
    throw new RunStoreError("workflow_child_handoff_missing");
  if (
    options.childrenEnabled &&
    current.nodes.some((n) => n.kind === "humanGate" && n.claimId !== null) &&
    !options.humanGatesEnabled
  )
    throw new RunStoreError("workflow_gate_unavailable");
  readSqliteWorkflowHumanGates(db, current, run, context, {
    requirePublishedGates: options.humanGatesEnabled,
  });
  const rows = readSqliteWorkflowNodes(db, current, context.workflow);
  for (const row of rows.values())
    sqliteWorkflowNodeAdmission(db, current, context.workflow, row);
  if (
    current.nodes.some(
      (node) =>
        (node.status === "running" || node.status === "unknown") &&
        !children.has(node.claimId!),
    )
  )
    throw new RunStoreError("workflow_node_recovery_required");
  const firstPropagation = !current.cancelRequested;
  signalChildCancellations(db, run, request, children, ops, options.nextId);
  if (firstPropagation) {
    const nodes = cancelSqliteWorkflowUnstartedNodes(
      db,
      current,
      context.workflow,
      now,
    );
    const next = projectWorkflowExecution(
      { ...current, cancelRequested: true },
      nodes,
      now,
    );
    writeSqliteWorkflowExecution(db, current, next);
    current = next;
  }
  current = reconcileSqliteWorkflowChildren(db, {
    parent: run,
    state: current,
    children,
    context,
    loadRun: ops.loadRun,
    now,
  });
  ops.validateLease(input, ops.now());
  return current;
}

type SignalOperations = Pick<
  WorkflowChildOperations,
  "loadRun" | "commitChildRun"
> &
  Pick<WorkflowRootOperations, "now">;
/** The already-authorized cancellation command owns this transaction, not an execution lease.
 * Only cancellation flags/events and queue availability change; DAG claims/settlements still require a scheduler lease.
 */
export function signalSqliteWorkflowCancellationRequest(
  db: DatabaseSync,
  run: RunState,
  events: readonly RunLifecycleEvent[],
  ops: SignalOperations,
): void {
  if (
    run.purpose !== "workflow" ||
    !events.some((event) => event.type === "run.cancel.requested")
  )
    return;
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name='workflow_run_admissions'",
      )
      .get() ||
    !db
      .prepare(
        "SELECT 1 FROM workflow_run_admissions WHERE tenant_id=? AND run_id=?",
      )
      .get(run.tenantId, run.runId)
  )
    return;
  assertSqliteWorkflowCancellationSchema(db);
  const wake = db
    .prepare(
      "SELECT work_item_id FROM workflow_cancellation_wakes WHERE tenant_id=? AND run_id=?",
    )
    .get(run.tenantId, run.runId);
  if (!wake)
    throw new RunStoreError("workflow_cancel_request_authority_missing");
  const context = readSqliteWorkflowCompositionContext(db, {
    run,
    binding: run.workflowVersionBinding!,
    lease: { workItemId: String(wake.work_item_id) },
  });
  const state = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name='workflow_executions'")
    .get()
    ? readSqliteWorkflowExecution(db, run)
    : null;
  if (state === null) {
    db.prepare(
      "UPDATE workflow_cancellation_wakes SET children_signaled=1 WHERE tenant_id=? AND run_id=?",
    ).run(run.tenantId, run.runId);
    return;
  }
  const children = readSqliteWorkflowChildren(db, state, run, ops.loadRun);
  const rows = readSqliteWorkflowNodes(db, state, context.workflow);
  for (const row of rows.values())
    sqliteWorkflowNodeAdmission(db, state, context.workflow, row);
  signalChildCancellations(
    db,
    run,
    cancellationRequest(db, run),
    children,
    ops,
    randomUUID,
  );
}
function signalChildCancellations(
  db: DatabaseSync,
  run: RunState,
  request: Extract<RunLifecycleEvent, { type: "run.cancel.requested" }>,
  children: ReadonlyMap<string, WorkflowChildRow>,
  ops: SignalOperations,
  nextId: () => string,
) {
  const marker = db
    .prepare(
      "SELECT children_signaled FROM workflow_cancellation_wakes WHERE tenant_id=? AND run_id=?",
    )
    .get(run.tenantId, run.runId);
  if (
    !marker ||
    (marker.children_signaled !== 0 && marker.children_signaled !== 1)
  )
    throw new RunStoreError("workflow_cancel_request_authority_missing");
  const signaled = marker.children_signaled === 1;
  for (const row of children.values()) {
    const child = ops.loadRun({
      tenantId: run.tenantId,
      runId: row.child_run_id,
    })!;
    if (["completed", "failed", "canceled"].includes(child.status)) continue;
    const work = readSqliteWorkflowChildWorkItem(db, run, child, row);
    if (signaled) {
      if (!child.cancelRequested)
        throw new RunStoreError("workflow_child_cancel_authority_conflict");
      continue;
    }
    if (!child.cancelRequested) {
      commitSqliteWorkflowChildCancellation(
        {
          child,
          actorId: request.data.actorId,
          idempotency: {
            scope: canonicalJson({
              namespace: "workflow.child-cancel.v1",
              tenantId: run.tenantId,
              runId: run.runId,
            }),
            key: row.claim_id,
            requestFingerprint: workflowAdmissionDigest.sha256(
              canonicalJson({
                requestEventId: request.eventId,
                childRunId: child.runId,
                claimId: row.claim_id,
                binding: run.workflowVersionBinding,
              }),
            ),
          },
        },
        ops,
        nextId,
      );
    }
    wakeSqliteWorkflowChildCancellation(db, child, work, ops);
  }

  if (!signaled)
    db.prepare(
      "UPDATE workflow_cancellation_wakes SET children_signaled=1 WHERE tenant_id=? AND run_id=?",
    ).run(run.tenantId, run.runId);
}

function cancellationRequest(
  db: DatabaseSync,
  run: RunState,
): Extract<RunLifecycleEvent, { type: "run.cancel.requested" }> {
  const row = db
    .prepare(
      `SELECT w.request_sequence,
    CASE WHEN length(CAST(e.event_json AS BLOB))<=16384 THEN e.event_json ELSE NULL END AS json
    FROM workflow_cancellation_wakes w JOIN run_events e ON e.tenant_id=w.tenant_id AND e.run_id=w.run_id AND e.sequence=w.request_sequence
    WHERE w.tenant_id=? AND w.run_id=?`,
    )
    .get(run.tenantId, run.runId);
  if (!row || typeof row.json !== "string")
    throw new RunStoreError("workflow_cancel_request_authority_missing");
  const event = JSON.parse(row.json);
  if (
    event.type !== "run.cancel.requested" ||
    event.identity?.runId !== run.runId ||
    event.sequence !== row.request_sequence ||
    event.sequence > run.lastSequence ||
    typeof event.eventId !== "string" ||
    !event.eventId ||
    typeof event.data?.actorId !== "string" ||
    !event.data.actorId
  )
    throw new RunStoreError("workflow_cancel_request_authority_missing");
  return event;
}
