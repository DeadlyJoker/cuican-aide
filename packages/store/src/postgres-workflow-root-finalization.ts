import type { PoolClient } from "pg";
import {
  canonicalJson,
  RunStoreError,
  type CommitRunResult,
  type WorkflowSchedulerInput,
} from "@crewon/application";
import type { RunState, ThreadState } from "@crewon/domain";
import type { PostgresWorkflowCompositionDependencies } from "./postgres-workflow-run-composition.ts";
import type { readPostgresWorkflowCompositionContext } from "./postgres-workflow-composition-context.ts";
import { readPostgresWorkflowSchedulerAuthority } from "./postgres-workflow-scheduler-authority.ts";
import {
  workflowRootOutcome,
  workflowRootFinalizationKey,
  prepareWorkflowRootCompletion,
} from "./workflow-root-result.ts";
import {
  decodePostgresRunReceipt,
  decodePostgresRunEvent,
  type PostgresRunEventRow,
} from "./postgres-run-codec.ts";
import { readPostgresWorkflowRunOutput } from "./postgres-workflow-run-output.ts";

type Context = Awaited<
  ReturnType<typeof readPostgresWorkflowCompositionContext>
>;

/** Caller owns the parent lock and transaction; terminal receipt replay is checked before allocating IDs. */
export async function finalizePostgresWorkflowRoot(
  client: PoolClient,
  sql: string,
  input: WorkflowSchedulerInput,
  run: RunState,
  context: Context,
  ops: PostgresWorkflowCompositionDependencies,
  options: {
    now: string;
    nextId(): string;
    alreadySettled: boolean;
    humanGatesEnabled: boolean;
  },
): Promise<{ disposition: "committed" | "replayed"; run: RunState }> {
  const authority = await readPostgresWorkflowSchedulerAuthority(
    client,
    sql,
    input,
    run,
    context,
    ops,
    options,
  );
  const { execution, rows, children } = authority;
  if (run.cancelRequested || execution.cancelRequested)
    throw new RunStoreError("workflow_cancellation_recovery_required");
  if (
    !["completed", "failed"].includes(execution.status) ||
    execution.nodes.some((node) =>
      ["running", "unknown", "waitingHuman"].includes(node.status),
    ) ||
    [...children.values()].some(
      (child) =>
        !["completed", "failed", "canceled"].includes(child.run.status),
    )
  )
    throw new RunStoreError("workflow_finalization_pending");
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
    canceled: false,
  });
  const prior = (
    await client.query<{
      tenant_id: string;
      run_id: string;
      fingerprint: string | null;
      result_json: unknown;
    }>(
      `SELECT tenant_id,run_id,CASE WHEN octet_length(fingerprint)<=128 THEN fingerprint ELSE NULL END AS fingerprint,
     CASE WHEN octet_length(result_json::text)<=16384 THEN result_json ELSE NULL END AS result_json FROM ${sql}.idempotency_receipts WHERE scope=$1 AND idempotency_key=$2`,
      [idempotency.scope, idempotency.key],
    )
  ).rows[0];
  if (prior) {
    if (
      prior.tenant_id !== input.tenantId ||
      prior.run_id !== input.runId ||
      prior.fingerprint !== idempotency.requestFingerprint ||
      !prior.result_json
    )
      corrupt();
    const receipt = decodePostgresRunReceipt({
      ...prior,
      fingerprint: prior.fingerprint!,
    });
    if (
      canonicalJson(receipt.state) !== canonicalJson(run) ||
      run.status !== (output ? "completed" : "failed") ||
      receipt.events.length !== (output ? 2 : 1) ||
      receipt.workItems.length !== 0 ||
      receipt.outbox.length !== receipt.events.length
    )
      corrupt();
    const events = await client.query<PostgresRunEventRow>(
      `SELECT tenant_id,run_id,sequence,event_id,CASE WHEN octet_length(event_json::text)<=16384 THEN event_json ELSE NULL END AS event_json FROM ${sql}.run_events WHERE tenant_id=$1 AND run_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 3`,
      [run.tenantId, run.runId, run.lastSequence - receipt.events.length],
    );
    if (
      events.rows.some((row) => row.event_json === null) ||
      canonicalJson(
        events.rows.map((row) => decodePostgresRunEvent(row, run)),
      ) !== canonicalJson(receipt.events)
    )
      corrupt();
    if (
      output &&
      (await readPostgresWorkflowRunOutput(client, sql, run)) !== output.json
    )
      corrupt();
    if (!output && (run.failure?.code !== failureCode || run.failure.retryable))
      corrupt();
    if (!options.alreadySettled) await ops.settleRootWork(client, input);
    return { disposition: "replayed", run };
  }
  if (options.alreadySettled || run.status !== "running")
    throw new RunStoreError("workflow_root_terminal_authority_missing");
  await reserve(client, `idempotency:${idempotency.scope}:${idempotency.key}`);
  // Do not hold a parent Run while waiting for a different Thread transaction.
  await reserve(client, `thread:${run.tenantId}:${run.threadId}`);
  let thread: ThreadState | null = null;
  let historyHead = 0;
  if (output) {
    const bytes = (
      await client.query<{ bytes: number }>(
        `SELECT octet_length(state_json::text) AS bytes FROM ${sql}.threads WHERE tenant_id=$1 AND thread_id=$2`,
        [run.tenantId, run.threadId],
      )
    ).rows[0];
    if (bytes && bytes.bytes > 65536)
      throw new RunStoreError("workflow_root_thread_limit");
    thread = await ops.loadRootThread(client, {
      tenantId: run.tenantId,
      threadId: run.threadId,
    });
    const head = (
      await client.query<{ n: string }>(
        `SELECT COALESCE(MAX(sequence),0) AS n FROM ${sql}.model_history_items WHERE tenant_id=$1 AND thread_id=$2`,
        [run.tenantId, run.threadId],
      )
    ).rows[0]!;
    historyHead = Number(head.n);
    if (!Number.isSafeInteger(historyHead) || historyHead < 0)
      throw new RunStoreError("workflow_root_history_limit");
  }
  const prepared = prepareWorkflowRootCompletion({
    run,
    thread,
    historyHead,
    output,
    failureCode,
    canceled: false,
    idempotency,
    now: options.now,
    nextId: options.nextId,
  });
  if (
    prepared.thread &&
    (await ops.commitRootThread(client, prepared.thread)).disposition !==
      "committed"
  )
    throw new RunStoreError("workflow_root_terminal_authority_missing");
  const result = await ops.commitRoot(client, prepared.commit, input.lease);
  if (result.disposition !== "committed") corrupt();
  if (Buffer.byteLength(canonicalJson(result)) > 16384)
    throw new RunStoreError("workflow_root_receipt_limit");
  await ops.settleRootWork(client, input);
  return { disposition: "committed", run: result.state };
}
async function reserve(client: PoolClient, key: string) {
  const result = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
    [key],
  );
  if (result.rows[0]?.acquired !== true)
    throw new RunStoreError("postgres_retryable");
}
function corrupt(): never {
  throw new RunStoreError("workflow_root_receipt_corrupt");
}
