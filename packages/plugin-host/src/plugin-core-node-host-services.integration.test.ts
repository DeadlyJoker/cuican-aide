import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "@crewon/application";
import {
  deferred,
  taskActionFixture,
} from "./plugin-task-action-bridge.integration.test-support.ts";

test("versioned task catalog preserves the actual installed Node invocation, SQLite commit and original receipt replay", async (t) => {
  const f = await taskActionFixture(t, { nodeServiceCatalog: "versioned" });
  const before = await f.counts();
  const output = await f.invoke();
  assert.equal(f.state.accepted.length, 1);
  const committed = f.state.accepted[0]!;
  assert.deepEqual(output, {
    disposition: "committed",
    threadId: committed.binding.threadId,
    threadRevision: committed.turn.threadState.revision,
    runId: committed.binding.runId,
    messageId: committed.turn.messages[0]!.messageId,
    configurationRevision: committed.binding.configurationRevision,
  });
  const after = await f.counts();
  for (const table of [
    "messages",
    "run_snapshots",
    "plugin_task_admissions",
    "plugin_credit_reservations",
  ])
    assert.equal(after[table], before[table]! + 1, table);
  f.state.useSecondConnection = true;
  const replay = await f.invoke();
  assert.deepEqual(replay, {
    ...(output as Record<string, unknown>),
    disposition: "replayed",
  });
  assert.equal(f.state.accepted[1]!.binding.runId, committed.binding.runId);
  assert.equal(f.state.quoteCalls, 1);
  assert.deepEqual(await f.counts(), after);
});

test("versioned task catalog still rechecks current authority after an actual quote await", async (t) => {
  const f = await taskActionFixture(t, { nodeServiceCatalog: "versioned" });
  const before = await f.counts();
  const entered = deferred();
  const resume = deferred();
  f.state.quoteEntered = entered.resolve;
  f.state.quoteGate = resume.promise;
  const invoking = f.invoke();
  void invoking.catch(() => {});
  try {
    await entered.promise;
    f.state.epoch = "versioned-catalog-revoked-epoch";
  } finally {
    resume.resolve();
  }
  await assert.rejects(
    invoking,
    (error: unknown) =>
      error instanceof ApplicationError && error.category === "authorization",
  );
  assert.equal(f.state.quoteCalls, 1);
  assert.equal(f.state.accepted.length, 0);
  assert.deepEqual(await f.counts(), before);
});

test("versioned catalog neither converts host identity into UI permission nor restores a withdrawn owner", async (t) => {
  const f = await taskActionFixture(t, { nodeServiceCatalog: "versioned" });
  const before = await f.counts();
  f.state.denyUi = true;
  await assert.rejects(f.invoke());
  assert.equal(f.state.quoteCalls, 0);
  assert.deepEqual(await f.counts(), before);
  f.state.denyUi = false;
  f.bridge.close();
  await assert.rejects(f.invoke(), { code: "plugin_invocation_unavailable" });
  assert.equal(f.state.quoteCalls, 0);
  assert.deepEqual(await f.counts(), before);
});
