import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  canonicalJson,
  initialWorkflowExecution,
  projectWorkflowExecution,
  RunStoreError,
  type WorkflowSchedulerInput,
} from "@crewon/application";
import type { RunState, RunLifecycleEvent } from "@crewon/domain";
import { readPostgresWorkflowCancellationRequest } from "./postgres-workflow-cancellation-authority.ts";
import {
  readPostgresWorkflowExecution,
  writePostgresWorkflowExecution,
} from "./postgres-workflow-execution-authority.ts";
import { readPostgresWorkflowSchedulerAuthority } from "./postgres-workflow-scheduler-authority.ts";
import { assertPostgresWorkflowCompositionSchema } from "./postgres-workflow-composition-schema.ts";
import { postgresWorkflowHumanGateSchemaPresent } from "./postgres-workflow-human-gate-schema.ts";
import { readPostgresWorkflowChildWork } from "./postgres-workflow-child-work.ts";
import {
  lockPostgresWorkflowChild,
  commitPostgresWorkflowChildCancellation,
  wakePostgresWorkflowChildCancellation,
  type PostgresWorkflowCancellationOperations,
} from "./postgres-workflow-child-cancellation.ts";
import type { PostgresWorkflowChildRow } from "./postgres-workflow-children.ts";
import { workflowAdmissionDigest } from "./workflow-run-admission-validation.ts";
import { cancelPostgresWorkflowUnstartedNodes } from "./postgres-workflow-unstarted-cancellation.ts";
import { reconcilePostgresWorkflowChildren } from "./postgres-workflow-child-reconciliation.ts";
import type { PostgresWorkflowCompositionDependencies } from "./postgres-workflow-run-composition.ts";
import type { GateContext } from "./workflow-human-gate-authority.ts";

/** The already-authorized request owns this transaction. Claims and Attempt settlements still require a scheduler lease. */
export async function signalPostgresWorkflowCancellationRequest(
  client: PoolClient,
  sql: string,
  run: RunState,
  events: readonly RunLifecycleEvent[],
  ops: PostgresWorkflowCancellationOperations,
) {
  if (
    run.purpose !== "workflow" ||
    !events.some((event) => event.type === "run.cancel.requested")
  )
    return;
  const present = (
    await client.query<{ name: string | null }>(
      "SELECT to_regclass($1) AS name",
      [`${sql}.workflow_run_admissions`],
    )
  ).rows[0]!.name;
  if (
    present === null ||
    !(
      await client.query(
        `SELECT 1 FROM ${sql}.workflow_run_admissions WHERE tenant_id=$1 AND run_id=$2`,
        [run.tenantId, run.runId],
      )
    ).rows.length
  )
    return;
  await assertPostgresWorkflowCompositionSchema(client, sql.slice(1, -1));
  const proof = await readPostgresWorkflowCancellationRequest(client, sql, run);
  if (
    !events.some(
      (event) => canonicalJson(event) === canonicalJson(proof.request),
    )
  )
    throw new RunStoreError("workflow_cancel_request_authority_missing");
  const state = await readPostgresWorkflowExecution(client, sql, run);
  if (state === null) {
    // No execution state may hide an already-started external node.
    if (
      (
        await client.query(
          `SELECT 1 FROM ${sql}.run_steps WHERE tenant_id=$1 AND run_id=$2 LIMIT 1`,
          [run.tenantId, run.runId],
        )
      ).rows.length
    )
      throw new RunStoreError("workflow_composition_authority_missing");
    await markSignaled(client, sql, run);
    return;
  }
  const authority = await readPostgresWorkflowSchedulerAuthority(
    client,
    sql,
    { ...run, binding: run.workflowVersionBinding! },
    run,
    proof.context,
    ops,
    {
      humanGatesEnabled: await postgresWorkflowHumanGateSchemaPresent(
        client,
        sql.slice(1, -1),
      ),
    },
  );
  await signalChildren(
    client,
    sql,
    run,
    proof,
    authority.children,
    ops,
    randomUUID,
  );
}

/** Caller owns the parent lease and transaction. Cancellation permission comes from the persisted user request. */
export async function propagatePostgresWorkflowCancellation(
  client: PoolClient,
  sql: string,
  input: WorkflowSchedulerInput,
  run: RunState,
  context: GateContext,
  ops: PostgresWorkflowCompositionDependencies,
  options: { humanGatesEnabled: boolean; now: string; nextId(): string },
) {
  if (!run.cancelRequested || !["queued", "running"].includes(run.status))
    throw new RunStoreError("workflow_root_cancellation_required");
  const proof = await readPostgresWorkflowCancellationRequest(client, sql, run);
  let state = await readPostgresWorkflowExecution(client, sql, run);
  if (!state) {
    state = initialWorkflowExecution({
      ...input,
      workflow: context.workflow,
      now: options.now,
    });
    await writePostgresWorkflowExecution(client, sql, null, state);
  }
  const authority = await readPostgresWorkflowSchedulerAuthority(
    client,
    sql,
    input,
    run,
    context,
    ops,
    options,
  );
  await signalChildren(
    client,
    sql,
    run,
    proof,
    authority.children,
    ops,
    options.nextId,
  );
  if (!state.cancelRequested) {
    const nodes = await cancelPostgresWorkflowUnstartedNodes(
      client,
      sql,
      state,
      context.workflow,
      options.now,
    );
    const next = projectWorkflowExecution(
      { ...state, cancelRequested: true },
      nodes,
      options.now,
    );
    await writePostgresWorkflowExecution(client, sql, state, next);
    state = next;
  }
  return reconcilePostgresWorkflowChildren(client, sql, {
    parent: run,
    state,
    children: authority.children,
    rows: authority.rows,
    admissions: authority.admissions,
    now: options.now,
  });
}

async function signalChildren(
  client: PoolClient,
  sql: string,
  parent: RunState,
  proof: Awaited<ReturnType<typeof readPostgresWorkflowCancellationRequest>>,
  children: ReadonlyMap<string, PostgresWorkflowChildRow & { run: RunState }>,
  ops: PostgresWorkflowCancellationOperations,
  nextId: () => string,
) {
  for (const target of children.values()) {
    if (terminal(target.run.status)) continue;
    const child = await lockPostgresWorkflowChild(client, parent, target, ops);
    if (terminal(child.status)) continue;
    const source = await readPostgresWorkflowChildWork(
      client,
      sql,
      parent,
      child,
      target,
    );
    if (source.kind !== "live")
      throw new RunStoreError("workflow_child_work_authority_missing");
    if (proof.signaled) {
      if (!child.cancelRequested)
        throw new RunStoreError("workflow_child_cancel_authority_conflict");
      continue;
    }
    if (!child.cancelRequested) {
      const idempotency = {
        scope: canonicalJson({
          namespace: "workflow.child-cancel.v1",
          tenantId: parent.tenantId,
          runId: parent.runId,
        }),
        key: target.claim_id,
        requestFingerprint: workflowAdmissionDigest.sha256(
          canonicalJson({
            requestEventId: proof.request.eventId,
            childRunId: child.runId,
            claimId: target.claim_id,
            binding: parent.workflowVersionBinding,
          }),
        ),
      };
      await commitPostgresWorkflowChildCancellation(
        client,
        sql,
        {
          child,
          actorId: proof.request.data.actorId,
          idempotency,
          work: source.work,
        },
        ops,
        nextId,
      );
    } else
      await wakePostgresWorkflowChildCancellation(
        client,
        sql,
        child,
        source.work,
      );
  }
  if (!proof.signaled) await markSignaled(client, sql, parent);
}
async function markSignaled(client: PoolClient, sql: string, run: RunState) {
  if (
    (
      await client.query(
        `UPDATE ${sql}.workflow_cancellation_wakes SET children_signaled=true WHERE tenant_id=$1 AND run_id=$2`,
        [run.tenantId, run.runId],
      )
    ).rowCount !== 1
  )
    throw new RunStoreError("workflow_cancel_request_authority_missing");
}
function terminal(status: string) {
  return ["completed", "failed", "canceled"].includes(status);
}
