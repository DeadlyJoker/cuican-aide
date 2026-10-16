import { readPostgresWorkflowHumanGates } from "./postgres-workflow-human-gate-authority.ts";
import type { PoolClient } from "pg";
import {
  RunStoreError,
  type WorkflowSchedulerInput,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import { readPostgresWorkflowExecution } from "./postgres-workflow-execution-authority.ts";
import {
  readPostgresWorkflowNodes,
  postgresWorkflowNodeAdmission,
} from "./postgres-workflow-node-authority.ts";
import {
  readPostgresWorkflowChildren,
  type PostgresWorkflowChildOperations,
} from "./postgres-workflow-children.ts";
import type { readPostgresWorkflowCompositionContext } from "./postgres-workflow-composition-context.ts";

/** No additional aggregate write locks: the caller already owns the parent Run and queue fence. */
export async function readPostgresWorkflowSchedulerAuthority(
  client: PoolClient,
  sql: string,
  input: Pick<WorkflowSchedulerInput, "tenantId" | "runId" | "binding">,
  run: RunState,
  context: Awaited<ReturnType<typeof readPostgresWorkflowCompositionContext>>,
  ops: PostgresWorkflowChildOperations,
  options: { humanGatesEnabled: boolean },
) {
  if (run.goalBinding !== null || run.goalAccounting !== null)
    throw new RunStoreError("workflow_root_goal_unsupported");
  const execution = await readPostgresWorkflowExecution(client, sql, input);
  if (!execution) throw new RunStoreError("workflow_execution_not_found");
  if (
    execution.workflowId !== input.binding.workflowId ||
    execution.workflowVersionId !== input.binding.workflowVersionId ||
    execution.contentDigest !== input.binding.contentDigest
  )
    throw new RunStoreError("workflow_execution_binding_mismatch");
  const rows = await readPostgresWorkflowNodes(
    client,
    sql,
    execution,
    context.workflow,
  );
  if (!rows.size)
    throw new RunStoreError("workflow_composition_authority_missing");
  for (const row of rows.values())
    await postgresWorkflowNodeAdmission(
      client,
      sql,
      execution,
      context.workflow,
      row,
    );
  const children = await readPostgresWorkflowChildren(
    client,
    sql,
    execution,
    run,
    context,
    ops,
  );
  for (const node of execution.nodes) {
    if (node.claimId === null) continue;
    if (node.kind === "humanGate") continue;
    if (!children.has(node.claimId))
      throw new RunStoreError("workflow_child_handoff_missing");
  }
  const gates = await readPostgresWorkflowHumanGates(
    client,
    sql,
    execution,
    run,
    context,
    options.humanGatesEnabled,
  );
  const steps = await client.query<{ step_id: string }>(
    `SELECT step_id FROM ${sql}.run_steps WHERE tenant_id=$1 AND run_id=$2 LIMIT 65`,
    [run.tenantId, run.runId],
  );
  const ids = new Set([...rows.values()].map((row) => row.step_id));
  if (
    steps.rows.length !== ids.size ||
    steps.rows.some((row) => !ids.has(row.step_id))
  )
    throw new RunStoreError("workflow_root_step_authority_conflict");
  return { execution, rows, children, gates };
}
