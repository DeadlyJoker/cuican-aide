import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PluginUiJsonValue } from "@crewon/application";
import { seedThread } from "../../store/src/thread-store-conformance.test-support.ts";
import { extensionStoreDigester } from "../../store/src/extension-store-records.ts";
import { startExternalOperationFixtureRun } from "../../store/src/external-operation-run.test-support.ts";
import {
  actor,
  taskActionFixture,
  deferred,
} from "./plugin-task-action-bridge.integration.test-support.ts";
async function fixture(t: Parameters<typeof taskActionFixture>[0]) {
  const f = await taskActionFixture(t, { queryTasks: true });
  await f.invoke();
  const source = f.state.accepted[0]!;
  await startExternalOperationFixtureRun(f.first.parent, source.binding);
  const operationId = randomUUID();
  await f.operations.reserveExternalOperation({
    tenantId: actor.tenantId,
    runId: source.binding.runId,
    bindingDigest: source.binding.bindingDigest,
    operationId,
    executionId: "query-fixture",
    idempotencyKey: "query-op",
    actionDigest: extensionStoreDigester.sha256("action"),
    requestDigest: extensionStoreDigester.sha256("request"),
    correlationId: operationId,
    createdAt: f.state.now,
  });
  await seedThread(f.first.parent, {
    ...actor,
    threadId: "installed-query-thread",
  });
  const input = {
    threadId: "installed-query-thread",
    expectedThreadRevision: 1,
    idempotencyKey: "query-once",
    sourceRunId: source.binding.runId,
    operationId,
  };
  return {
    ...f,
    source,
    operationId,
    input,
    query: () => f.invoke("image.query", input),
  };
}
for (const change of ["none", "disable", "epoch", "close"] as const)
  test(`installed tasks v2: exact query COMMIT receipt survives ${change} without generation credit`, async (t) => {
    const f = await fixture(t),
      before = await f.counts(),
      account = await f.credits.getAccount({
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        poolId: "installed-plugin-fixture-pool",
      });
    f.state.afterCommit = async () => {
      if (change === "disable") await f.disable();
      else if (change === "epoch") f.state.epoch = "revoked-query-epoch";
      else if (change === "close") f.bridge.close();
    };
    const output = await f.query(),
      accepted = f.state.accepted[1]!;
    assert.deepEqual(output, {
      disposition: "committed",
      threadId: accepted.binding.threadId,
      threadRevision: accepted.turn.threadState.revision,
      runId: accepted.binding.runId,
      messageId: accepted.turn.messages[0]!.messageId,
      configurationRevision: accepted.binding.configurationRevision,
    });
    assert.equal(accepted.creditAdmission, undefined);
    const query = await f.first.store.loadPluginQueryTaskAdmission(
      accepted.binding,
    );
    assert.ok(query);
    assert.equal(query.action, "image.query");
    assert.equal(query.source.runId, f.source.binding.runId);
    assert.equal(query.operationId, f.operationId);
    assert.equal(f.state.quoteCalls, 1);
    assert.equal(
      await f.first.store.loadPluginTaskAdmission(accepted.binding),
      null,
    );
    const after = await f.counts();
    for (const table of [
      "plugin_task_admissions",
      "extension_credit_admissions",
      "plugin_credit_reservations",
      "plugin_credit_entries",
    ])
      assert.equal(after[table], before[table]);
    assert.equal(after.run_snapshots, before.run_snapshots! + 1);
    assert.deepEqual(
      await f.credits.getAccount({
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        poolId: "installed-plugin-fixture-pool",
      }),
      account,
    );
    if (change === "none") {
      f.state.useSecondConnection = true;
      assert.deepEqual(await f.query(), {
        ...(output as Record<string, unknown>),
        disposition: "replayed",
      });
      assert.deepEqual(await f.counts(), after);
    } else {
      await assert.rejects(f.query());
      assert.deepEqual(await f.counts(), after);
    }
  });
for (const change of [
  "epoch",
  "disable",
  "closeMount",
  "sourceRead",
  "queryThread",
] as const)
  test(`installed tasks v2: ${change} revoked during query readiness leaves zero query writes`, async (t) => {
    const f = await fixture(t),
      before = await f.counts(),
      entered = deferred(),
      resume = deferred();
    f.state.queryEntered = entered.resolve;
    f.state.queryGate = resume.promise;
    const invoking = f.query();
    void invoking.catch(() => {});
    try {
      await entered.promise;
      if (change === "epoch") f.state.epoch = "changed-before-query-commit";
      else if (change === "disable") await f.disable();
      else if (change === "closeMount")
        await f.service.closeMount(actor, { mountRef: f.lease.mountRef });
      else
        f.extensionState.denied =
          change === "sourceRead" ? "run:read" : "thread:message:append";
    } finally {
      resume.resolve();
    }
    await assert.rejects(invoking);
    assert.deepEqual(await f.counts(), before);
    assert.equal(await f.count("plugin_query_task_admissions"), 0);
    assert.equal(f.state.accepted.length, 1);
    assert.equal(f.state.quoteCalls, 1);
  });
test("installed tasks v2: query request cannot smuggle generation authority, provider configuration or an invocation", async (t) => {
  const f = await fixture(t),
    before = await f.counts();
  const patches: readonly Record<string, PluginUiJsonValue>[] = [
    { input: {} },
    { packageDigest: f.installed.packageDigest },
    { configurationRevision: 1 },
    { actorId: actor.actorId },
    { invocationRef: "invented" },
    { operationId: randomUUID() },
    { sourceRunId: "missing" },
  ];
  for (const patch of patches)
    await assert.rejects(f.invoke("image.query", { ...f.input, ...patch }));
  assert.deepEqual(await f.counts(), before);
  assert.equal(f.state.quoteCalls, 1);
});
