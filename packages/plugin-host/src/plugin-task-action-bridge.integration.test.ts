import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "@crewon/application";
import {
  actor,
  commandInput,
  creditScope,
  deferred,
  taskActionFixture,
} from "./plugin-task-action-bridge.integration.test-support.ts";

type Fixture = Awaited<ReturnType<typeof taskActionFixture>>;
const authorizationFailure = (error: unknown) =>
  error instanceof ApplicationError && error.category === "authorization";

async function assertOnePaidTask(
  f: Fixture,
  before: Awaited<ReturnType<Fixture["counts"]>>,
  output: unknown,
) {
  assert.equal(f.state.accepted.length, 1);
  const accepted = f.state.accepted[0]!;
  assert.deepEqual(output, {
    disposition: "committed",
    threadId: accepted.binding.threadId,
    threadRevision: accepted.turn.threadState.revision,
    runId: accepted.binding.runId,
    messageId: accepted.turn.messages[0]!.messageId,
    configurationRevision: accepted.binding.configurationRevision,
  });
  const after = await f.counts();
  for (const table of [
    "messages",
    "model_history_items",
    "run_snapshots",
    "extension_run_bindings",
    "plugin_task_admissions",
    "extension_credit_admissions",
    "plugin_credit_reservations",
    "plugin_credit_entries",
  ])
    assert.equal(after[table], before[table]! + 1, table);
  const admission = await f.first.store.loadPluginTaskAdmission(
    accepted.binding,
  );
  assert.ok(admission);
  assert.equal(admission.packageDigest, f.installed.packageDigest);
  assert.equal(admission.selectionRevision, f.enabled.selection.revision);
  assert.equal(admission.principalId, actor.principalId);
  assert.equal(admission.profileId, f.profile.profileId);
  const paid = await f.first.store.loadExtensionCreditAdmission(
    accepted.binding,
  );
  assert.deepEqual(paid, accepted.creditAdmission);
  const account = await f.credits.getAccount(creditScope);
  assert.equal(account?.availableCredits, "70");
  assert.equal(account?.reservedCredits, "30");
  assert.equal(account?.spentCredits, "0");
  assert.equal(f.state.quoteCalls, 1);
  return { after, paid, account };
}

for (const change of ["disable", "epoch", "close"] as const) {
  test(`installed task bridge: confirmed paid COMMIT returns its original receipt after ${change}`, async (t) => {
    const f = await taskActionFixture(t);
    const before = await f.counts();
    f.state.afterCommit = async () => {
      if (change === "disable") await f.disable();
      else if (change === "epoch") {
        f.state.epoch = "installed-task-epoch-2";
        f.state.now = "2026-09-30T00:02:00.000Z";
      } else f.bridge.close();
    };
    const output = await f.invoke();
    const { after } = await assertOnePaidTask(f, before, output);
    // The committed result is a receipt, never a reusable authorization to start another task.
    await assert.rejects(
      f.invoke("image.generate", {
        ...commandInput,
        idempotencyKey: "a-new-generation",
      }),
    );
    assert.deepEqual(await f.counts(), after);
    assert.equal(f.state.quoteCalls, 1);
  });
}

for (const change of ["epoch", "selection", "runPermission"] as const) {
  test(`installed task bridge: revoking ${change} during a real quote await leaves no Turn, Run or credit hold`, async (t) => {
    const f = await taskActionFixture(t);
    const before = await f.counts();
    const entered = deferred();
    const resume = deferred();
    f.state.quoteEntered = entered.resolve;
    f.state.quoteGate = resume.promise;
    const invoking = f.invoke();
    void invoking.catch(() => {});
    try {
      await entered.promise;
      if (change === "epoch") f.state.epoch = "installed-task-revoked-epoch";
      else if (change === "selection") await f.disable();
      else f.extensionState.denied = "extension:run";
    } finally {
      resume.resolve();
    }
    await assert.rejects(invoking, authorizationFailure);
    assert.deepEqual(await f.counts(), before);
    assert.equal(f.state.accepted.length, 0);
    assert.equal(f.state.quoteCalls, 1);
    const account = await f.credits.getAccount(creditScope);
    assert.equal(account?.availableCredits, "100");
    assert.equal(account?.reservedCredits, "0");
  });
}

test("installed task bridge: an ordinary completed read keeps the post-read revocation fence", async (t) => {
  const f = await taskActionFixture(t);
  const before = await f.counts();
  const entered = deferred();
  const resume = deferred();
  f.state.readEntered = entered.resolve;
  f.state.readGate = resume.promise;
  const invoking = f.invoke("image.read", null);
  void invoking.catch(() => {});
  try {
    await entered.promise;
    f.state.epoch = "installed-task-read-revoked";
  } finally {
    resume.resolve();
  }
  await assert.rejects(invoking, authorizationFailure);
  assert.deepEqual(await f.counts(), before);
  assert.equal(f.state.quoteCalls, 0);
  assert.equal(f.state.accepted.length, 0);
});

test("installed task bridge: closing the plugin page during a quote await revokes the uncommitted invocation", async (t) => {
  const f = await taskActionFixture(t);
  const before = await f.counts();
  const entered = deferred();
  const resume = deferred();
  f.state.quoteEntered = entered.resolve;
  f.state.quoteGate = resume.promise;
  const invoking = f.invoke();
  void invoking.catch(() => {});
  try {
    await entered.promise;
    await f.service.closeMount(actor, { mountRef: f.lease.mountRef });
  } finally {
    resume.resolve();
  }
  await assert.rejects(
    invoking,
    (error: unknown) =>
      error instanceof ApplicationError &&
      /^(?:plugin_ui_(?:mount|invocation)_unavailable|plugin_invocation_(?:authority_changed|unavailable))$/u.test(
        error.code,
      ),
  );
  assert.deepEqual(await f.counts(), before);
  assert.equal(f.state.accepted.length, 0);
  assert.equal(f.state.quoteCalls, 1);
  const account = await f.credits.getAccount(creditScope);
  assert.equal(account?.availableCredits, "100");
  assert.equal(account?.reservedCredits, "0");
});

test("installed task bridge: a retry on the second real SQLite connection replays the original paid receipt without quoting again", async (t) => {
  const f = await taskActionFixture(t);
  const before = await f.counts();
  const output = await f.invoke();
  const saved = await assertOnePaidTask(f, before, output);
  // A later fixture price must not replace an already frozen reservation on receipt replay.
  f.state.quote = { ...f.state.quote, priceRevision: 2, quotedCredits: "90" };
  f.state.useSecondConnection = true;
  const replay = await f.invoke();
  assert.deepEqual(replay, {
    ...(output as Record<string, unknown>),
    disposition: "replayed",
  });
  assert.equal(f.state.accepted.length, 2);
  assert.equal(f.state.accepted[1]!.run.disposition, "replayed");
  assert.equal(
    f.state.accepted[1]!.binding.runId,
    f.state.accepted[0]!.binding.runId,
  );
  assert.deepEqual(
    await f.second.store.loadExtensionCreditAdmission(
      f.state.accepted[1]!.binding,
    ),
    saved.paid,
  );
  assert.deepEqual(await f.credits.getAccount(creditScope), saved.account);
  assert.deepEqual(await f.counts(), saved.after);
  assert.equal(f.state.quoteCalls, 1);
});
