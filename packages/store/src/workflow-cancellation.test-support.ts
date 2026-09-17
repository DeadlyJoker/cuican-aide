import type { CommitRunResult } from "@crewon/application";
import type { SqliteRunStore } from "./sqlite-run-store.ts";
import type { SqliteWorkflowChildDispatchOptions } from "./sqlite-workflow-child-dispatch.ts";
import type { compositionFixture } from "./workflow-run-composition.test-support.ts";

export const cancellationChildDispatch: SqliteWorkflowChildDispatchOptions = {
  resolveRoute: ({ parent, node }) => ({
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
};
export async function requestWorkflowCancel(
  store: SqliteRunStore,
  input: { tenantId: string; runId: string },
  now: number,
): Promise<CommitRunResult> {
  const run = await store.loadRun(input);
  if (!run) throw Error("missing root");
  return store.commitRun({
    tenantId: input.tenantId,
    expectedRevision: run.revision,
    idempotency: {
      scope: "workflow-cancel-test",
      key: `${input.runId}-${run.lastSequence}`,
      requestFingerprint: "cancel",
    },
    events: [
      {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: input.runId },
        eventId: `${input.runId}-cancel-${run.lastSequence}`,
        sequence: run.lastSequence + 1,
        occurredAt: new Date(now).toISOString(),
        type: "run.cancel.requested",
        data: { actorId: "canceling-actor" },
      },
    ],
    outbox: [],
    workItems: [],
  });
}
export function cancellationSnapshot(
  f: Pick<Awaited<ReturnType<typeof compositionFixture>>, "database">,
) {
  return Object.fromEntries(
    [
      "threads",
      "thread_events",
      "messages",
      "model_history_items",
      "thread_idempotency_receipts",
      "run_snapshots",
      "run_events",
      "run_steps",
      "run_attempts",
      "work_items",
      "outbox",
      "idempotency_receipts",
      "workflow_node_admissions",
      "workflow_executions",
      "workflow_cancellation_wakes",
    ].map((table) => [
      table,
      f.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  );
}
