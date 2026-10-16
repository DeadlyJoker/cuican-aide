import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  projectWorkflowExecution,
  RunStoreError,
  type WorkflowExecutionState,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import type {
  WorkflowChildOperations,
  WorkflowChildRow,
} from "./sqlite-workflow-child-dispatch.ts";
import type { readSqliteWorkflowCompositionContext } from "./sqlite-workflow-composition-context.ts";
import { finishSqliteRunAttempt } from "./sqlite-execution-authority.ts";
import {
  readSqliteWorkflowNodes,
  sqliteWorkflowNodeAdmission,
} from "./sqlite-workflow-node-authority.ts";
import { writeSqliteWorkflowExecution } from "./sqlite-workflow-execution-authority.ts";
import { workflowChildOutcome } from "./workflow-child-outcome.ts";
import { readSqliteWorkflowRunOutput } from "./sqlite-workflow-run-output.ts";
import { hasSqliteWorkflowFailureCancellation } from "./sqlite-workflow-failure-cancellation.ts";

/** Caller already holds a current scheduler lease and an encompassing transaction. */
export function reconcileSqliteWorkflowChildren(
  db: DatabaseSync,
  input: {
    parent: RunState;
    state: WorkflowExecutionState;
    children: ReadonlyMap<string, WorkflowChildRow>;
    context: ReturnType<typeof readSqliteWorkflowCompositionContext>;
    loadRun: WorkflowChildOperations["loadRun"];
    now: string;
  },
): WorkflowExecutionState {
  let current = input.state;
  const rows = readSqliteWorkflowNodes(db, current, input.context.workflow);
  for (const childRow of input.children.values()) {
    const node = current.nodes.find(
      (value) => value.nodeId === childRow.node_id,
    )!;
    if (
      node.status === "completed" ||
      node.status === "failed" ||
      node.status === "canceled"
    )
      continue;
    const child = input.loadRun({
      tenantId: current.tenantId,
      runId: childRow.child_run_id,
    })!;
    if (
      child.status !== "completed" &&
      child.status !== "failed" &&
      child.status !== "canceled"
    )
      continue;
    const row = rows.get(node.nodeId)!,
      admission = sqliteWorkflowNodeAdmission(
        db,
        current,
        input.context.workflow,
        row,
      );
    const canceled =
      child.status === "canceled" &&
      (current.cancelRequested ||
        hasSqliteWorkflowFailureCancellation(
          db,
          input.parent,
          child,
          childRow,
          current,
          rows,
        ));
    let output: string | null = null,
      outputError: unknown;
    if (child.status === "completed") {
      try {
        output = readSqliteWorkflowRunOutput(db, child);
      } catch (error) {
        outputError = error;
      }
    }
    const { status, failureCode, value } = workflowChildOutcome({
      child,
      canceledByParent: canceled,
      output,
      outputError,
      schema: admission.claim.node.outputSchema,
    });
    finishSqliteRunAttempt(db, {
      tenantId: current.tenantId,
      runId: current.runId,
      workItemId: row.work_item_id,
      leaseEpoch: row.lease_epoch,
      attempt: {
        stepId: admission.step.stepId,
        attemptId: admission.attempt!.attemptId,
        finishedAt: input.now,
        checkpointDigest: null,
        ...(status !== "failed"
          ? { status }
          : { status, failure: { code: failureCode!, retryable: false } }),
      },
    });
    const nextNode = {
      ...node,
      status,
      leaseExpiresAt: null,
      resultDigest: value?.digest ?? null,
      failureCode,
    };
    const next = projectWorkflowExecution(
      current,
      current.nodes.map((candidate) =>
        candidate.nodeId === node.nodeId ? nextNode : candidate,
      ),
      input.now,
    );
    writeSqliteWorkflowExecution(db, current, next);
    const fingerprint = canonicalJson({
      kind: "workflow.node-settle.v1",
      nodeId: node.nodeId,
      claimId: node.claimId,
      outcome:
        status === "completed"
          ? { status, digest: value!.digest }
          : status === "canceled"
            ? { status }
            : { status, failureCode },
    });
    const updated = db
      .prepare(
        "UPDATE workflow_node_admissions SET output_digest=?,output_json=?,settlement_fingerprint=? WHERE tenant_id=? AND run_id=? AND node_id=? AND settlement_fingerprint IS NULL",
      )
      .run(
        value?.digest ?? null,
        value?.json ?? null,
        fingerprint,
        current.tenantId,
        current.runId,
        node.nodeId,
      );
    if (updated.changes !== 1)
      throw new RunStoreError("workflow_node_settlement_conflict");
    current = next;
  }
  return current;
}
