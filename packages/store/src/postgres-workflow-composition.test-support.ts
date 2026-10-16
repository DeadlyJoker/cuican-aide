import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { WorkItemClaim } from "@crewon/application";
import { postgresWorkflowAdmissionFixture } from "./postgres-workflow-run-admission.test-support.ts";
import {
  compositionInput,
  parallelVersion,
} from "./workflow-run-composition.test-support.ts";
import type { PostgresWorkflowCompositionOptions } from "./postgres-workflow-run-composition.ts";

type SnapshotRow = {
  [key: string]: unknown;
  state_json: Record<string, unknown>;
  work_item_id: string;
};

export async function postgresCompositionFixture(
  t: TestContext,
  options: {
    asset?: ReturnType<typeof parallelVersion>;
    composition?: Partial<PostgresWorkflowCompositionOptions>;
    prepare?: boolean;
  } = {},
) {
  const f = await postgresWorkflowAdmissionFixture(t, options);
  const started = await f.start();
  const root = started.run.state;
  let ids = 0;
  const config: PostgresWorkflowCompositionOptions = {
    nextId: () => `pg-composition-${++ids}`,
    authorize: () => ({ outcome: "allow" }),
    resolveChildRoute: ({ parent, node }) => ({
      authorityId: parent.authorityId,
      runtimeGeneration: parent.runtimeGeneration,
      policySnapshotId: parent.policySnapshotId,
      workspaceBindingId: parent.workspaceBindingId,
      agentVersionId:
        node.kind === "agent"
          ? node.agentVersionId
          : node.kind === "verification"
            ? node.verifierAgentVersionId
            : "unsupported-gate",
    }),
    ...options.composition,
  };
  const composition = f.store.experimentalWorkflowRunCompositionStore(config);
  await composition.migrate();
  const claim = await f.store.claimNextWorkItem({
    ownerId: "parent-owner",
    leaseId: "parent-lease",
    leaseDurationMs: 60_000,
  });
  assert.ok(claim);
  const input = compositionInput(root.workflowVersionBinding!, claim);
  if (options.prepare !== false) await composition.prepareWorkflowRun(input);
  const tables = [
    "threads",
    "thread_events",
    "messages",
    "model_history_items",
    "thread_idempotency_receipts",
    "run_snapshots",
    "run_events",
    "run_thread_bindings",
    "run_steps",
    "run_attempts",
    "work_items",
    "outbox",
    "idempotency_receipts",
    "workflow_executions",
    "workflow_node_admissions",
    "workflow_node_passes",
    "workflow_node_children",
  ];
  const snapshot = async (): Promise<Record<string, SnapshotRow[]>> =>
    Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [
          table,
          (
            await f.admin.query<{ row: SnapshotRow }>(
              `SELECT row_to_json(r) AS row FROM ${f.sql}.${table} r ORDER BY row_to_json(r)::text`,
            )
          ).rows.map((r) => r.row),
        ]),
      ),
    );
  return {
    ...f,
    root,
    input,
    composition,
    config,
    snapshot,
    ids: () => ids,
    children: async () =>
      (
        await f.admin.query<{
          node_id: string;
          claim_id: string;
          child_thread_id: string;
          child_run_id: string;
          wake_work_item_id: string;
        }>(`SELECT * FROM ${f.sql}.workflow_node_children ORDER BY node_id`)
      ).rows,
    async reclaim() {
      await f.admin.query(
        `UPDATE ${f.sql}.work_items SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE work_item_id=$1`,
        [input.lease.workItemId],
      );
      const next = await f.store.claimNextWorkItem({
        ownerId: "reopened-owner",
        leaseId: "reopened-lease",
        leaseDurationMs: 60_000,
      });
      assert.ok(next);
      assert.equal(next.workItem.workItemId, input.lease.workItemId);
      return compositionInput(input.binding, next as WorkItemClaim);
    },
  };
}
