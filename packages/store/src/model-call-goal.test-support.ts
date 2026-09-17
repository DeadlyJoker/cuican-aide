import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import {
  ThreadGoalApplicationService,
  type DomainStore,
} from "@crewon/application";
import { InMemoryRunStore } from "./in-memory-run-store.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import {
  createRunningCommitFixture,
  ManualLeaseClock,
} from "./run-store-conformance.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { modelUsageInput } from "./model-usage-store.test-support.ts";
import { modelCallInput } from "./model-call-store.test-support.ts";

export async function modelCallGoalFixture(
  t: TestContext,
  backend: "memory" | "sqlite" | "postgres",
) {
  const root = mkdtempSync(join(tmpdir(), "crewon-call-goal-")),
    path = join(root, "store.sqlite");
  const schema = `crewon_call_goal_${randomUUID().replaceAll("-", "_")}`;
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  if (backend === "postgres") assert.ok(connectionString);
  const clock = new ManualLeaseClock();
  const opened: DomainStore[] = [];
  const open = async () => {
    const store =
      backend === "memory"
        ? new InMemoryRunStore({ clock })
        : backend === "sqlite"
          ? new SqliteRunStore(path, { clock })
          : await PostgresDomainStore.open({
              connectionString: connectionString!,
              schema,
              maxPoolSize: 2,
            });
    opened.push(store);
    return store;
  };
  let store = await open();
  t.after(async () => {
    for (const value of opened) await value.close();
    if (backend === "postgres") {
      const admin = new Pool({ connectionString, max: 1 });
      try {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  await seedThread(store);
  await store.commitRun(createRunningCommitFixture());
  const actor = {
    tenantId: "tenant-1",
    spaceId: "space-1",
    actorId: "actor-1",
    principalId: "principal-1",
  };
  let identifier = 0,
    instant = Date.parse("2026-08-08T00:01:01Z");
  const changeGoal = async (objective: string | null) => {
    const service = new ThreadGoalApplicationService({
      store,
      authorization: { authorize: async () => ({ outcome: "allow" }) },
      clock: { now: () => new Date((instant += 1000)).toISOString() },
      ids: { nextId: (kind) => `${kind}-${++identifier}` },
      digester: {
        sha256: (value) =>
          `sha256:${createHash("sha256").update(value).digest("hex")}`,
      },
      routeResolver: {
        resolveRoute: async () =>
          assert.fail("running Run must retain its route"),
      },
    });
    const current = await store.loadThreadGoal({
      tenantId: actor.tenantId,
      threadId: "thread-1",
    });
    const common = {
      threadId: "thread-1",
      idempotencyKey: `mutation-${++identifier}`,
      expectedRevision: current?.revision ?? null,
    };
    return objective === null
      ? service.clearGoal(actor, { ...common, kind: "thread.goal.clear" })
      : service.setGoal(actor, {
          ...common,
          kind: "thread.goal.set",
          objective,
          status: "active",
          tokenBudget: { kind: "set", value: 200000 },
        });
  };
  const firstGoal = (await changeGoal("first objective")).goalState!;
  const claim = await store.claimNextWorkItem({
    ownerId: "model-accounting",
    leaseId: "model-accounting",
    leaseDurationMs: 60000,
  });
  assert.ok(claim);
  const lease = {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
  const started = await store.beginRunAttempt({
    tenantId: actor.tenantId,
    runId: claim.workItem.runId,
    lease,
    stepId: "model-step-1",
    kind: "model",
    attemptId: "attribution-attempt",
    startedAt: "2026-08-08T00:01:02Z",
  });
  const source = modelUsageInput(
    claim,
    started.step.stepId,
    started.attempt.attemptId,
  );
  return {
    persistence: { path, schema, connectionString },
    firstGoal,
    source,
    changeGoal,
    store: () => store,
    intent: (callId: string) => modelCallInput(source, callId),
    rows: () =>
      store.listModelCalls({ ...source.record, afterOrder: 0, limit: 128 }),
    reopen: async () => {
      if (backend !== "memory") {
        await store.close();
        store = await open();
      }
    },
    eraseLegacyAttribution: async () => {
      if (backend === "sqlite") {
        const database = new DatabaseSync(path);
        try {
          database.exec(
            "UPDATE model_call_observations SET record_json=json_remove(record_json,'$.goalAttribution')",
          );
        } finally {
          database.close();
        }
      } else if (backend === "postgres") {
        const admin = new Pool({ connectionString, max: 1 });
        try {
          await admin.query(
            `UPDATE "${schema}".model_call_observations SET record_json=record_json-'goalAttribution'`,
          );
        } finally {
          await admin.end();
        }
      } else assert.fail("legacy fixture requires persisted JSON");
    },
  };
}
