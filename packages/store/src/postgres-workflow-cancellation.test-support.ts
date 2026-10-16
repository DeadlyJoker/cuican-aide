import type { TestContext } from "node:test";
import {
  RunApplicationService,
  type AuthorizationPort,
  type WorkflowExecutionState,
} from "@crewon/application";
import { postgresGateFixture } from "./postgres-workflow-human-gate.test-support.ts";
import {
  admissionVersion,
  admissionActor,
} from "./workflow-run-admission.test-support.ts";
import type { PostgresRunStore } from "./postgres-run-store.ts";
export const cancellationActor = {
  ...admissionActor,
  actorId: "canceling-actor",
  principalId: "canceling-principal",
};

export async function postgresCancellationFixture(
  t: TestContext,
  options: Parameters<typeof postgresGateFixture>[1] = {},
) {
  const f = await postgresGateFixture(t, {
    asset: admissionVersion(),
    ...options,
  });
  let command:
    | {
        kind: "run.requestCancel";
        runId: string;
        expectedRevision: number;
        idempotencyKey: string;
      }
    | undefined;
  let ids = 0;
  return {
    ...f,
    async request(
      store: PostgresRunStore = f.store,
      authorization: AuthorizationPort = {
        authorize: async () => ({ outcome: "allow" }),
      },
    ) {
      if (!command)
        command = {
          kind: "run.requestCancel",
          runId: f.root.runId,
          expectedRevision: (await f.store.loadRun(f.root))!.revision,
          idempotencyKey: "root-cancel-fixture",
        };
      return new RunApplicationService({
        store,
        authorization,
        clock: { now: () => new Date().toISOString() },
        ids: { nextId: () => `root-cancel-event-${++ids}` },
      }).transitionRun(cancellationActor, command);
    },
    execution: async () =>
      (
        await f.admin.query<{ state_json: WorkflowExecutionState }>(
          `SELECT state_json FROM ${f.sql}.workflow_executions WHERE tenant_id=$1 AND run_id=$2`,
          [f.root.tenantId, f.root.runId],
        )
      ).rows[0]?.state_json ?? null,
    snapshot: async (): Promise<Awaited<ReturnType<typeof f.snapshot>>> => ({
      ...(await f.snapshot()),
      workflow_cancellation_wakes: (
        await f.admin.query(
          `SELECT * FROM ${f.sql}.workflow_cancellation_wakes ORDER BY run_id`,
        )
      ).rows,
    }),
  };
}
