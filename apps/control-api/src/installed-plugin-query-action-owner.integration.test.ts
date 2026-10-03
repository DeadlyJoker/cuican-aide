import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import { startExternalOperationFixtureRun } from "../../../packages/store/src/external-operation-run.test-support.ts";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import {
  actor,
  creditScope,
  deferred,
  ownedActionFixture,
} from "./installed-plugin-task-action-owner.test-support.ts";
async function fixture(
  t: Parameters<typeof ownedActionFixture>[0],
  backend: "sqlite" | "postgres",
) {
  const f = await ownedActionFixture(t, { backend, queryTasks: true });
  await f.invoke();
  const source = f.state.accepted[0]!,
    operationId = randomUUID();
  await startExternalOperationFixtureRun(f.first.parent, source.binding);
  await f.operations.reserveExternalOperation({
    tenantId: actor.tenantId,
    runId: source.binding.runId,
    bindingDigest: source.binding.bindingDigest,
    operationId,
    executionId: "owned-query-source",
    idempotencyKey: "owned-query-source",
    actionDigest: extensionStoreDigester.sha256("action"),
    requestDigest: extensionStoreDigester.sha256("request"),
    correlationId: operationId,
    createdAt: "2026-09-30T00:00:00.000Z",
  });
  await seedThread(f.first.parent, {
    ...actor,
    threadId: "owned-query-thread",
  });
  const input = {
    threadId: "owned-query-thread",
    expectedThreadRevision: 1,
    idempotencyKey: "owned-query",
    sourceRunId: source.binding.runId,
    operationId,
  };
  return { ...f, source, input, query: () => f.invoke("image.query", input) };
}
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: actual owned tasks v2 action freezes old source after package upgrade without a new credit hold`,
    options,
    async (t) => {
      const f = await fixture(t, backend),
        upgrade = await f.install("0.2.0"),
        mount = await f.open(),
        account = await f.credits.getAccount(creditScope);
      const output = await f.invoke("image.query", f.input, actor, mount),
        accepted = f.state.accepted[1]!,
        query = await f.second.store.loadPluginQueryTaskAdmission(
          accepted.binding,
        );
      assert.ok(query);
      assert.equal(query.packageDigest, upgrade.packageDigest);
      assert.equal(query.source.packageDigest, f.installed.packageDigest);
      assert.equal(query.operationId, f.input.operationId);
      assert.deepEqual(accepted.binding.target, f.source.binding.target);
      assert.equal(accepted.creditAdmission, undefined);
      assert.equal(f.state.quoteCalls, 1);
      assert.deepEqual(await f.credits.getAccount(creditScope), account);
      const replay = await f.invoke("image.query", f.input, actor, mount);
      assert.deepEqual(replay, {
        ...(output as Record<string, unknown>),
        disposition: "replayed",
      });
      assert.equal(await f.count("plugin_query_task_admissions"), 1);
      assert.equal(await f.count("plugin_task_admissions"), 1);
    },
  );
  test(
    `${backend}: actual owned query returns confirmed COMMIT while owner closes and cannot be reused as admission`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      let closing: Promise<void> | undefined;
      f.state.afterCommit = async () => {
        closing = f.owner.close();
      };
      const output = await f.query(),
        accepted = f.state.accepted[1]!;
      assert.equal(
        (output as Record<string, unknown>).runId,
        accepted.binding.runId,
      );
      assert.equal(
        (output as Record<string, unknown>).disposition,
        "committed",
      );
      assert.equal(accepted.creditAdmission, undefined);
      await closing;
      await assert.rejects(f.query());
      assert.equal(f.state.accepted.length, 2);
      assert.equal(f.state.quoteCalls, 1);
      assert.equal(
        (await f.credits.getAccount(creditScope))?.reservedCredits,
        "30",
      );
    },
  );
  test(
    `${backend}: actual owned query loses source permission during readiness with no Turn or query provenance`,
    options,
    async (t) => {
      const f = await fixture(t, backend),
        before = await f.counts(),
        entered = deferred(),
        resume = deferred();
      f.state.queryEntered = entered.resolve;
      f.state.queryGate = resume.promise;
      const work = f.query();
      void work.catch(() => {});
      try {
        await entered.promise;
        f.extensionState.denied = "run:read";
      } finally {
        resume.resolve();
      }
      await assert.rejects(work);
      assert.deepEqual(await f.counts(), before);
      assert.equal(await f.count("plugin_query_task_admissions"), 0);
      assert.equal(f.state.quoteCalls, 1);
    },
  );
}
