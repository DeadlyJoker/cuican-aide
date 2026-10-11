import assert from "node:assert/strict";
import test from "node:test";
import {
  deferred,
  taskActionFixture,
} from "./plugin-task-action-bridge.integration.test-support.ts";
import { lifecycleProviderId } from "./plugin-task-action-composition.test-support.ts";
import { withdrawAfterActualInsert } from "../../store/src/plugin-task-commit-authority.test-support.ts";

test("owner borrowing uses the installed shared instance and releases every physical handle after real paid admission", async (t) => {
  const f = await taskActionFixture(t, {
    composition: true,
    profileBorrower: true,
  });
  assert.equal(f.nodeHost, null);
  assert.ok(f.coordinator);
  const before = f.coordinator.snapshot().map((entry) => entry.identity);
  assert.deepEqual(await f.invoke("image.read", null), {
    value: "read fixture",
  });
  const result = await f.invoke();
  assert.equal(f.state.accepted.length, 1);
  const saved = f.state.accepted[0]!;
  assert.equal((result as { runId: string }).runId, saved.binding.runId);
  assert.ok(await f.first.store.loadPluginTaskAdmission(saved.binding));
  assert.equal(f.state.quoteCalls, 1);
  assert.deepEqual(
    f.coordinator.snapshot().map((entry) => entry.identity),
    before,
  );
  assert.ok(f.state.physicalBorrows > 1);
  assert.equal(f.state.physicalReleases, f.state.physicalBorrows);
});

for (const phase of ["read", "quote"] as const) {
  test(`owner borrowing releases all handles when the provider is withdrawn during ${phase}`, async (t) => {
    const f = await taskActionFixture(t, {
      composition: true,
      profileBorrower: true,
    });
    assert.ok(f.coordinator);
    const before = await f.counts();
    const entered = deferred();
    const resume = deferred();
    if (phase === "read") {
      f.state.readEntered = entered.resolve;
      f.state.readGate = resume.promise;
    } else {
      f.state.quoteEntered = entered.resolve;
      f.state.quoteGate = resume.promise;
    }
    const pending = f.invoke(
      phase === "read" ? "image.read" : "image.generate",
      phase === "read" ? null : undefined,
    );
    void pending.catch(() => {});
    try {
      await entered.promise;
      assert.equal(f.state.physicalBorrows - f.state.physicalReleases, 1);
      f.coordinator.revoke(lifecycleProviderId);
    } finally {
      resume.resolve();
    }
    await assert.rejects(pending);
    assert.deepEqual(await f.counts(), before);
    assert.equal(f.state.accepted.length, 0);
    assert.equal(f.state.physicalReleases, f.state.physicalBorrows);
  });
}

test("owner borrowing still checks the actual instance after SQLite INSERT and before COMMIT", async (t) => {
  const f = await taskActionFixture(t, {
    composition: true,
    profileBorrower: true,
  });
  assert.ok(f.coordinator);
  const before = await f.counts();
  const hook = withdrawAfterActualInsert(
    "sqlite",
    "plugin_task_admissions",
    () => f.coordinator!.revoke(lifecycleProviderId),
  );
  try {
    await assert.rejects(f.invoke());
    assert.equal(hook.inserted(), 1);
  } finally {
    hook.restore();
  }
  assert.deepEqual(await f.counts(), before);
  assert.equal(f.state.accepted.length, 0);
  assert.equal(f.state.physicalReleases, f.state.physicalBorrows);
});

for (const mode of ["copied", "released", "extra", "accessor"] as const) {
  test(`owner borrowing rejects a ${mode} lease and cleans its physical handle without dispatch`, async (t) => {
    const f = await taskActionFixture(t, {
      composition: true,
      profileBorrower: true,
    });
    f.state.borrowMode = mode;
    const before = await f.counts();
    await assert.rejects(f.invoke());
    assert.deepEqual(await f.counts(), before);
    assert.equal(f.state.quoteCalls, 0);
    assert.equal(f.state.physicalReleases, f.state.physicalBorrows);
    f.state.borrowMode = "original";
    assert.deepEqual(await f.invoke("image.read", null), {
      value: "read fixture",
    });
    assert.equal(f.state.physicalReleases, f.state.physicalBorrows);
  });
}

test("an acknowledged original COMMIT survives bridge close and still releases the owner's handle", async (t) => {
  const f = await taskActionFixture(t, {
    composition: true,
    profileBorrower: true,
  });
  f.state.afterCommit = async () => f.bridge.close();
  const result = await f.invoke();
  assert.equal(f.state.accepted.length, 1);
  assert.equal(
    (result as { runId: string }).runId,
    f.state.accepted[0]!.binding.runId,
  );
  assert.equal(f.state.physicalReleases, f.state.physicalBorrows);
  await assert.rejects(f.invoke());
});
