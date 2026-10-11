import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { seedThread } from "../../store/src/thread-store-conformance.test-support.ts";
import { extensionStoreDigester } from "../../store/src/extension-store-records.ts";
import { startExternalOperationFixtureRun } from "../../store/src/external-operation-run.test-support.ts";
import {
  actor,
  deferred,
  taskActionFixture,
} from "./plugin-task-action-bridge.integration.test-support.ts";
import { lifecycleProviderId } from "./plugin-task-action-composition.test-support.ts";
import { withdrawAfterActualInsert } from "../../store/src/plugin-task-commit-authority.test-support.ts";

async function fixture(
  t: TestContext,
  backend: "sqlite" | "postgres" = "sqlite",
) {
  const f = await taskActionFixture(t, {
    composition: true,
    queryTasks: true,
    backend,
  });
  await f.invoke();
  const source = f.state.accepted[0]!;
  await startExternalOperationFixtureRun(f.first.parent, source.binding);
  const operationId = randomUUID();
  await f.operations.reserveExternalOperation({
    tenantId: actor.tenantId,
    runId: source.binding.runId,
    bindingDigest: source.binding.bindingDigest,
    operationId,
    executionId: "composed-query-fixture",
    idempotencyKey: "composed-query-operation",
    actionDigest: extensionStoreDigester.sha256("action"),
    requestDigest: extensionStoreDigester.sha256("request"),
    correlationId: operationId,
    createdAt: f.state.now,
  });
  await seedThread(f.first.parent, {
    ...actor,
    threadId: "composed-query-thread",
  });
  const query = () =>
    f.invoke("image.query", {
      threadId: "composed-query-thread",
      expectedThreadRevision: 1,
      idempotencyKey: "composed-query-once",
      sourceRunId: source.binding.runId,
      operationId,
    });
  return { ...f, query };
}

test("shared graph tasks v2 uses the original query admission and replay without another generation charge", async (t) => {
  const f = await fixture(t);
  const before = await f.counts();
  const output = await f.query();
  assert.equal((output as { disposition: string }).disposition, "committed");
  const admitted = f.state.accepted[1]!;
  assert.equal(admitted.creditAdmission, undefined);
  assert.ok(await f.first.store.loadPluginQueryTaskAdmission(admitted.binding));
  const after = await f.counts();
  for (const table of [
    "plugin_task_admissions",
    "plugin_credit_reservations",
    "plugin_credit_entries",
    "extension_credit_admissions",
  ])
    assert.equal(after[table], before[table]);
  assert.equal(f.state.quoteCalls, 1);
  f.state.useSecondConnection = true;
  assert.deepEqual(await f.query(), {
    ...(output as Record<string, unknown>),
    disposition: "replayed",
  });
  assert.deepEqual(await f.counts(), after);
});

test("provider withdrawal during original query readiness prevents all query admission writes", async (t) => {
  const f = await fixture(t);
  const before = await f.counts();
  const entered = deferred();
  const resume = deferred();
  f.state.queryEntered = entered.resolve;
  f.state.queryGate = resume.promise;
  const invocation = f.query();
  void invocation.catch(() => {});
  try {
    await entered.promise;
    f.coordinator!.revoke(lifecycleProviderId);
  } finally {
    resume.resolve();
  }
  await assert.rejects(invocation);
  assert.equal(f.state.accepted.length, 1);
  assert.deepEqual(await f.counts(), before);
});

test("shared provider withdrawal after confirmed query COMMIT preserves the original durable query receipt", async (t) => {
  const f = await fixture(t);
  f.state.afterCommit = async () => {
    f.coordinator!.revoke(lifecycleProviderId);
  };
  const output = await f.query();
  assert.equal((output as { disposition: string }).disposition, "committed");
  assert.equal(f.state.accepted.length, 2);
  const after = await f.counts();
  await assert.rejects(f.query());
  assert.deepEqual(await f.counts(), after);
  assert.equal(f.state.quoteCalls, 1);
});

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: actual provider withdrawal after query admission INSERT rolls back the entire original UI query`,
    {
      skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    },
    async (t) => {
      const f = await fixture(t, backend);
      const before = await f.counts();
      const hook = withdrawAfterActualInsert(
        backend,
        "plugin_query_task_admissions",
        () => f.coordinator!.revoke(lifecycleProviderId),
      );
      try {
        await assert.rejects(f.query());
        assert.equal(hook.inserted(), 1);
      } finally {
        hook.restore();
      }
      assert.equal(f.state.accepted.length, 1);
      assert.deepEqual(await f.counts(), before);
      assert.equal(f.state.quoteCalls, 1);
    },
  );
}
