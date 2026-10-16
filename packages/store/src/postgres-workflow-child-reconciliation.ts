import type { RunState } from "@crewon/domain";
import { hasPostgresWorkflowFailureCancellation } from "./postgres-workflow-failure-cancellation.ts";
import type { PoolClient } from "pg";
import {
  canonicalJson,
  projectWorkflowExecution,
  RunStoreError,
  type WorkflowExecutionState,
  type WorkflowNodeAttemptAdmission,
} from "@crewon/application";
import type { readPostgresWorkflowChildren } from "./postgres-workflow-children.ts";
import type { WorkflowNodeRow } from "./workflow-node-authority.ts";
import { writePostgresWorkflowExecution } from "./postgres-workflow-execution-authority.ts";
import { finishPostgresRunAttempt } from "./postgres-execution-authority.ts";
import { readPostgresWorkflowRunOutput } from "./postgres-workflow-run-output.ts";
import { workflowChildOutcome } from "./workflow-child-outcome.ts";

/** Parent Run and scheduler lease are already fenced; validated child snapshots never require a child write lock. */
export async function reconcilePostgresWorkflowChildren(
  client: PoolClient,
  sql: string,
  input: {
    state: WorkflowExecutionState;
    parent: RunState;
    rows: ReadonlyMap<string, WorkflowNodeRow>;
    admissions: ReadonlyMap<string, WorkflowNodeAttemptAdmission>;
    children: Awaited<ReturnType<typeof readPostgresWorkflowChildren>>;
    now: string;
  },
): Promise<WorkflowExecutionState> {
  let current = input.state;
  for (const childRow of input.children.values()) {
    const node = current.nodes.find((n) => n.nodeId === childRow.node_id)!;
    const child = childRow.run;
    if (terminal(node.status)) {
      if (
        !terminal(child.status) ||
        (node.status === "completed" && child.status !== "completed")
      )
        throw new RunStoreError("workflow_child_terminal_conflict");
      continue;
    }
    if (!terminal(child.status)) continue;
    const row = input.rows.get(node.nodeId);
    const admission = input.admissions.get(node.nodeId);
    if (!row || !admission)
      throw new RunStoreError("workflow_node_authority_corrupt");
    let output: string | null = null,
      outputError: unknown;
    if (child.status === "completed") {
      try {
        output = await readPostgresWorkflowRunOutput(client, sql, child);
      } catch (error) {
        outputError = error;
      }
    }
    const outcome = workflowChildOutcome({
      child,
      canceledByParent:
        current.cancelRequested ||
        (child.status === "canceled" &&
          (await hasPostgresWorkflowFailureCancellation(
            client,
            sql,
            input.parent,
            child,
            childRow,
            current,
            input.rows,
          ))),
      output,
      outputError,
      schema: admission.claim.node.outputSchema,
      node: admission.claim.node,
    });
    await finishPostgresRunAttempt(client, sql, {
      tenantId: current.tenantId,
      runId: current.runId,
      workItemId: row.work_item_id,
      leaseEpoch: row.lease_epoch,
      attempt: {
        stepId: admission.step.stepId,
        attemptId: admission.attempt!.attemptId,
        finishedAt: input.now,
        checkpointDigest: null,
        ...(outcome.status === "failed"
          ? {
              status: outcome.status,
              failure: { code: outcome.failureCode!, retryable: false },
            }
          : { status: outcome.status }),
      },
    });
    const nextNode = {
      ...node,
      status: outcome.status,
      leaseExpiresAt: null,
      resultDigest: outcome.value?.digest ?? null,
      failureCode: outcome.failureCode,
    };
    const next = projectWorkflowExecution(
      current,
      current.nodes.map((n) => (n.nodeId === node.nodeId ? nextNode : n)),
      input.now,
    );
    await writePostgresWorkflowExecution(client, sql, current, next);
    const fingerprint = canonicalJson({
      kind: "workflow.node-settle.v1",
      nodeId: node.nodeId,
      claimId: node.claimId,
      outcome:
        outcome.status === "completed"
          ? { status: outcome.status, digest: outcome.value!.digest }
          : outcome.status === "canceled"
            ? { status: outcome.status }
            : { status: outcome.status, failureCode: outcome.failureCode },
    });
    const updated = await client.query(
      `UPDATE ${sql}.workflow_node_admissions SET output_digest=$1,output_json=$2,settlement_fingerprint=$3
      WHERE tenant_id=$4 AND run_id=$5 AND node_id=$6 AND settlement_fingerprint IS NULL`,
      [
        outcome.value?.digest ?? null,
        outcome.value?.json ?? null,
        fingerprint,
        current.tenantId,
        current.runId,
        node.nodeId,
      ],
    );
    if (updated.rowCount !== 1)
      throw new RunStoreError("workflow_node_settlement_conflict");
    current = next;
  }
  return current;
}
function terminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}
