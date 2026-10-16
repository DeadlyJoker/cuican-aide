import { readPostgresWorkflowCancellationRequest } from "./postgres-workflow-cancellation-authority.ts";
import type { PoolClient } from "pg";
import {
  RunStoreError,
  type WorkflowSchedulerInput,
  type WorkflowSchedulerPassResult,
} from "@crewon/application";
import type { RunState } from "@crewon/domain";
import type { PostgresWorkflowCompositionDependencies } from "./postgres-workflow-run-composition.ts";
import type { readPostgresWorkflowCompositionContext } from "./postgres-workflow-composition-context.ts";
import { readPostgresWorkflowSchedulerAuthority } from "./postgres-workflow-scheduler-authority.ts";
import { readPostgresWorkflowChildWork } from "./postgres-workflow-child-work.ts";
import { finalizePostgresWorkflowRoot } from "./postgres-workflow-root-finalization.ts";
import { validateWorkflowSchedulerWorkItems } from "./workflow-run-admission-validation.ts";
import { writePostgresWorkItems } from "./postgres-run-writer.ts";

/** One bounded pass: durable wake creation and acknowledgement share the caller's transaction. */
export async function finishPostgresWorkflowSchedulerPass(
  client: PoolClient,
  sql: string,
  input: WorkflowSchedulerInput,
  run: RunState,
  context: Awaited<ReturnType<typeof readPostgresWorkflowCompositionContext>>,
  ops: PostgresWorkflowCompositionDependencies,
  options: {
    maximum: number;
    now: string;
    nextId(): string;
    alreadySettled: boolean;
    humanGatesEnabled: boolean;
  },
): Promise<WorkflowSchedulerPassResult> {
  const { execution, children } = await readPostgresWorkflowSchedulerAuthority(
    client,
    sql,
    input,
    run,
    context,
    ops,
    options,
  );
  if (run.cancelRequested)
    await readPostgresWorkflowCancellationRequest(client, sql, run);
  if (execution.cancelRequested && !run.cancelRequested)
    throw new RunStoreError("workflow_cancellation_recovery_required");
  let liveChildren = 0,
    ready = run.cancelRequested !== execution.cancelRequested;
  for (const node of execution.nodes) {
    if (node.claimId === null || node.kind === "humanGate") continue;
    const row = children.get(node.claimId)!;
    if (terminal(row.run.status)) {
      if (!terminal(node.status)) ready = true;
      if (node.status === "completed" && row.run.status !== "completed")
        throw new RunStoreError("workflow_child_terminal_conflict");
    } else {
      if (terminal(node.status))
        throw new RunStoreError("workflow_child_terminal_conflict");
      // This snapshot joins the exact creation queue and current child state. Completion can race the earlier child read.
      const source = await readPostgresWorkflowChildWork(
        client,
        sql,
        run,
        row.run,
        row,
      );
      if (source.kind === "terminal") ready = true;
      else liveChildren++;
    }
  }
  const humanGates = execution.nodes.filter(
    (node) => node.status === "waitingHuman",
  ).length;
  if (
    terminal(run.status) ||
    (!ready && terminal(execution.status) && liveChildren === 0)
  ) {
    const result = await finalizePostgresWorkflowRoot(
      client,
      sql,
      input,
      run,
      context,
      ops,
      options,
    );
    return { kind: "terminal", run: result.run };
  }
  if (options.alreadySettled)
    throw new RunStoreError("workflow_root_terminal_authority_missing");
  if (
    !run.cancelRequested &&
    execution.status !== "failed" &&
    liveChildren < options.maximum
  ) {
    const completed = new Set(
      execution.nodes
        .filter((node) => node.status === "completed")
        .map((node) => node.nodeId),
    );
    for (const node of execution.nodes) {
      if (node.status !== "pending") continue;
      const definition = context.workflow.nodes.find(
        (value) => value.nodeId === node.nodeId,
      )!;
      if (definition.dependsOn.every((id) => completed.has(id))) {
        if (node.kind === "humanGate" && !options.humanGatesEnabled)
          throw new RunStoreError("workflow_gate_unavailable");
        ready = true;
      }
    }
  }
  if (ready) {
    const wake = {
      ...context.workItem,
      workItemId: options.nextId(),
      createdAt: options.now,
      payload: {
        ...context.workItem.payload,
        schedulerOperationId: options.nextId(),
      },
    };
    validateWorkflowSchedulerWorkItems(
      [wake],
      run.runId,
      run.tenantId,
      () => false,
    );
    await writePostgresWorkItems(client, sql, [wake]);
  } else if (liveChildren === 0 && humanGates === 0)
    throw new RunStoreError("workflow_scheduler_wake_source_missing");
  await ops.settleRootWork(client, input);
  return ready
    ? { kind: "ready", runId: run.runId }
    : {
        kind: "waiting",
        runId: run.runId,
        children: liveChildren,
        humanGates,
      };
}
function terminal(status: string): boolean {
  return ["completed", "failed", "canceled"].includes(status);
}
