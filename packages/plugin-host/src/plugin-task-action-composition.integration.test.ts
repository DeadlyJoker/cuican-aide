import assert from "node:assert/strict";
import test from "node:test";
import { selectionRecipe } from "../../store/src/plugin-installation-store.test-support.ts";
import {
  actor,
  deferred,
  taskActionFixture,
} from "./plugin-task-action-bridge.integration.test-support.ts";
import { lifecycleProviderId } from "./plugin-task-action-composition.test-support.ts";
import { PluginCompositionCoordinator } from "./plugin-composition-coordinator.ts";
import { withdrawAfterActualInsert } from "../../store/src/plugin-task-commit-authority.test-support.ts";

test("shared composition UI action consumes the actual installed provider and the original paid task manager", async (t) => {
  const f = await taskActionFixture(t, { composition: true });
  assert.equal(f.nodeHost, null);
  assert.ok(f.coordinator);
  assert.deepEqual(
    f.coordinator
      .snapshot()
      .map((entry) => entry.identity.pluginId)
      .sort(),
    ["crewon.comfyui-krea2", lifecycleProviderId].sort(),
  );
  assert.deepEqual(await f.invoke("image.read", null), {
    value: "read fixture",
  });
  const before = await f.counts();
  const output = await f.invoke();
  const saved = f.state.accepted[0]!;
  assert.equal(f.state.accepted.length, 1);
  assert.equal(f.state.quoteCalls, 1);
  assert.deepEqual(output, {
    disposition: "committed",
    threadId: saved.binding.threadId,
    threadRevision: saved.turn.threadState.revision,
    runId: saved.binding.runId,
    messageId: saved.turn.messages[0]!.messageId,
    configurationRevision: saved.binding.configurationRevision,
  });
  const after = await f.counts();
  for (const table of [
    "messages",
    "run_snapshots",
    "plugin_task_admissions",
    "plugin_credit_reservations",
  ])
    assert.equal(after[table], before[table]! + 1, table);
});

for (const phase of ["read", "quote"] as const) {
  test(`withdrawing only the provider during a real ${phase} await rejects the shared UI invocation`, async (t) => {
    const f = await taskActionFixture(t, { composition: true });
    assert.ok(f.coordinator);
    assert.ok(f.provider);
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
    const invocation = f.invoke(
      phase === "read" ? "image.read" : "image.generate",
      phase === "read" ? null : undefined,
    );
    void invocation.catch(() => {});
    try {
      await entered.promise;
      f.coordinator.revoke(lifecycleProviderId);
      const disabled = await f.ledger.commitSelection(
        selectionRecipe(f.provider.selection, "provider-disable", {
          actor,
          state: "disabled",
        }),
      );
      f.provider.selection = disabled.selection;
    } finally {
      resume.resolve();
    }
    await assert.rejects(invocation);
    assert.equal(f.state.accepted.length, 0);
    assert.deepEqual(await f.counts(), before);
    await assert.rejects(f.invoke("image.read", null));
    const enabled = await f.ledger.commitSelection(
      selectionRecipe(f.provider.selection, "provider-restore", { actor }),
    );
    f.provider.selection = enabled.selection;
    await f.synchronize();
    f.state.readGate = null;
    assert.deepEqual(await f.invoke("image.read", null), {
      value: "read fixture",
    });
    assert.deepEqual(await f.counts(), before);
  });
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: withdrawing the actual shared provider after admission INSERT rolls back the entire paid UI task`,
    {
      skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    },
    async (t) => {
      const f = await taskActionFixture(t, { composition: true, backend });
      assert.ok(f.coordinator);
      const before = await f.counts();
      const hook = withdrawAfterActualInsert(
        backend,
        "plugin_task_admissions",
        () => f.coordinator!.revoke(lifecycleProviderId),
      );
      try {
        await assert.rejects(f.invoke());
        assert.equal(hook.inserted(), 1);
      } finally {
        hook.restore();
      }
      assert.equal(f.state.accepted.length, 0);
      assert.deepEqual(await f.counts(), before);
      assert.equal(f.state.quoteCalls, 1);
      await f.synchronize();
      assert.deepEqual(await f.invoke("image.read", null), {
        value: "read fixture",
      });
    },
  );
}

test("same-package reload after provider withdrawal cannot authorize a task using the old consumer identity", async (t) => {
  const f = await taskActionFixture(t, { composition: true });
  assert.ok(f.coordinator);
  const before = await f.counts();
  const entered = deferred();
  const resume = deferred();
  f.state.quoteEntered = entered.resolve;
  f.state.quoteGate = resume.promise;
  const invocation = f.invoke();
  void invocation.catch(() => {});
  try {
    await entered.promise;
    f.coordinator.revoke(lifecycleProviderId);
    await f.synchronize();
  } finally {
    resume.resolve();
  }
  await assert.rejects(invocation);
  assert.equal(f.state.accepted.length, 0);
  assert.deepEqual(await f.counts(), before);
  assert.deepEqual(await f.invoke("image.read", null), {
    value: "read fixture",
  });
});

test("a confirmed paid COMMIT still returns its receipt after shared provider withdrawal", async (t) => {
  const f = await taskActionFixture(t, { composition: true });
  assert.ok(f.coordinator);
  f.state.afterCommit = async () => {
    f.coordinator!.revoke(lifecycleProviderId);
  };
  const output = await f.invoke();
  assert.equal((output as { disposition: string }).disposition, "committed");
  assert.equal(f.state.accepted.length, 1);
  const after = await f.counts();
  await assert.rejects(f.invoke());
  assert.deepEqual(await f.counts(), after);
  assert.equal(f.state.quoteCalls, 1);
});

for (const digest of [null, `sha256:${"0".repeat(64)}`]) {
  test(`missing or stale host graph (${digest === null ? "missing" : "stale"}) cannot fall back to an isolated instance`, async (t) => {
    const f = await taskActionFixture(t, { composition: true });
    const before = await f.counts();
    f.state.compositionDigestOverride = digest;
    await assert.rejects(f.invoke("image.read", null));
    await assert.rejects(f.invoke());
    assert.deepEqual(await f.counts(), before);
    assert.equal(f.state.quoteCalls, 0);
    f.state.compositionDigestOverride = undefined;
    assert.deepEqual(await f.invoke("image.read", null), {
      value: "read fixture",
    });
  });
}

test("a coordinator-shaped object cannot provide UI action authority", async (t) => {
  const f = await taskActionFixture(t, { composition: true });
  assert.throws(
    () =>
      f.bridge.actionsFromComposition({
        coordinator: Object.create(PluginCompositionCoordinator.prototype),
        currentLock: () => null,
      }),
    /plugin_action_composition_owner_invalid/,
  );
});

test("the actual coordinator rejects a foreign profile or authority epoch even with its current lock", async (t) => {
  const f = await taskActionFixture(t, { composition: true });
  assert.ok(f.coordinator);
  const lock = await f.synchronize();
  for (const field of [
    "tenantId",
    "spaceId",
    "profileId",
    "authorityEpoch",
  ] as const)
    assert.throws(
      () =>
        f.coordinator!.acquireScopedCurrent({
          scope: { ...lock.scope, [field]: `${lock.scope[field]}-foreign` },
          lockDigest: lock.lockDigest,
          pluginId: f.installed.descriptor.pluginId,
          authorizeBorrow: () => "allow",
        }),
      /plugin_composition_scope_conflict/,
    );
});

for (const phase of ["read", "quote"] as const) {
  test(`a microtask withdraw after the final async ${phase} graph check cannot cross the synchronous consumption fence`, async (t) => {
    const original =
      PluginCompositionCoordinator.prototype.acquireScopedCurrent;
    let owner: PluginCompositionCoordinator | null = null;
    let armed = false;
    let withdrew = false;
    PluginCompositionCoordinator.prototype.acquireScopedCurrent = function (
      input,
    ) {
      const lease = original.call(this, input);
      if (this === owner && armed && !withdrew) {
        withdrew = true;
        queueMicrotask(() => this.revoke(lifecycleProviderId));
      }
      return lease;
    };
    t.after(() => {
      PluginCompositionCoordinator.prototype.acquireScopedCurrent = original;
    });
    const f = await taskActionFixture(t, { composition: true });
    owner = f.coordinator;
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
    const invocation = f.invoke(
      phase === "read" ? "image.read" : "image.generate",
      phase === "read" ? null : undefined,
    );
    void invocation.catch(() => {});
    try {
      await entered.promise;
      armed = true;
    } finally {
      resume.resolve();
    }
    await assert.rejects(invocation);
    assert.equal(withdrew, true);
    assert.equal(f.state.accepted.length, 0);
    assert.deepEqual(await f.counts(), before);
  });
}
