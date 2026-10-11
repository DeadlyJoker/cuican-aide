import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "@crewon/application";
import type { PluginProfileScope } from "@crewon/domain";
import { publishInstalledPluginComposition } from "@crewon/plugin-host";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import {
  createInstalledPluginTaskCompositionReader,
  INSTALLED_PLUGIN_TASK_COMPOSITION_POLICY_SCHEMA,
  type InstalledPluginTaskCompositionPolicy,
} from "./installed-plugin-task-composition-policy.ts";
import { createInstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";
import {
  actor,
  taskRuntimeCoreFixture,
} from "./installed-plugin-task-runtime-core.test-support.ts";

const epoch = "named-shared-core-source-epoch";

/** Named offline live-owner policy; it supplies no package or execution approval. */
function policyOwner() {
  const state = {
    scope: null as PluginProfileScope | null,
    epoch,
    revoked: false,
    checks: 0,
    onCheck: null as (() => void) | null,
  };
  const create = (
    scope: PluginProfileScope,
  ): InstalledPluginTaskCompositionPolicy => {
    state.scope = scope;
    return {
      schemaVersion: INSTALLED_PLUGIN_TASK_COMPOSITION_POLICY_SCHEMA,
      scope,
      authorityEpoch: state.epoch,
      assertCurrent() {
        state.checks++;
        if (state.revoked) throw new Error("named_composition_owner_withdrawn");
        state.onCheck?.();
        assert.ok(state.scope);
        return { ...state.scope, authorityEpoch: state.epoch };
      },
    };
  };
  return { state, create };
}

async function publish(
  f: Awaited<ReturnType<typeof taskRuntimeCoreFixture>>,
  authorityEpoch = epoch,
) {
  const compositions = f.storage.ledger.compositionStore();
  await compositions.migrate();
  const result = await publishInstalledPluginComposition({
    actor,
    scope: { ...f.storage.profile, authorityEpoch },
    installRoot: f.storage.installRoot,
    installations: f.storage.ledger,
    compositions,
    hostServices: [],
    signal: new AbortController().signal,
    authorizeSnapshot: async () => "allow",
  });
  return { compositions, lock: result.lock };
}

test("actual Core task captures its same-Store graph and receipt replay preserves it after head changes", async (t) => {
  const owner = policyOwner();
  const f = await taskRuntimeCoreFixture(t, {
    compositionPolicy: owner.create,
  });
  const original = await publish(f);
  const before = await f.storage.counts();
  await f.invoke();
  const accepted = f.state.accepted[0]!;
  assert.equal(
    accepted.binding.schemaVersion,
    "crewon.extension-run-binding.v1",
  );
  if (accepted.binding.schemaVersion !== "crewon.extension-run-binding.v1")
    assert.fail();
  assert.equal(
    accepted.binding.composition.lockDigest,
    original.lock.lockDigest,
  );
  assert.deepEqual(
    await f.storage.first.store.loadExtensionRunBinding(accepted.binding),
    accepted.binding,
  );
  const after = await f.storage.counts();
  for (const table of Object.keys(before))
    assert.equal(after[table], before[table]! + 1, table);
  const next = await publish(f, "named-new-composition-epoch");
  assert.notEqual(next.lock.lockDigest, original.lock.lockDigest);
  const checks = owner.state.checks;
  assert.equal(
    ((await f.invoke()) as { disposition: string }).disposition,
    "replayed",
  );
  assert.equal(
    owner.state.checks,
    checks,
    "receipt replay does not inspect today's graph",
  );
  assert.deepEqual(f.state.accepted[1]!.binding, accepted.binding);
  assert.deepEqual(await f.storage.counts(), after);
  assert.equal(f.state.quoteCalls, 1);
});

test("omitting Core composition policy preserves existing v0 even when a graph exists", async (t) => {
  const f = await taskRuntimeCoreFixture(t);
  await publish(f);
  await f.invoke();
  assert.equal(
    f.state.accepted[0]!.binding.schemaVersion,
    "crewon.extension-run-binding.v0",
  );
});

test("explicit Core policy cannot silently fall back to v0 when its current graph is missing", async (t) => {
  const owner = policyOwner();
  const f = await taskRuntimeCoreFixture(t, {
    compositionPolicy: owner.create,
  });
  await f.storage.ledger.compositionStore().migrate();
  const before = await f.effects();
  await assert.rejects(f.invoke(), /plugin_task_composition_missing/);
  assert.deepEqual(await f.effects(), before);
  assert.deepEqual(f.state.accepted, []);
});

test("explicit Core policy refuses a current head from an earlier authority epoch without admission", async (t) => {
  const owner = policyOwner();
  const f = await taskRuntimeCoreFixture(t, {
    compositionPolicy: owner.create,
  });
  await publish(f, "previous-host-authority-epoch");
  const before = await f.effects();
  await assert.rejects(
    f.invoke(),
    /installed_plugin_task_composition_authority_changed/,
  );
  assert.deepEqual(await f.effects(), before);
  assert.deepEqual(f.state.accepted, []);
});

for (const change of ["withdraw", "scope", "epoch"] as const) {
  test(`actual Core does not commit when the live composition owner changes ${change} during its read`, async (t) => {
    const owner = policyOwner();
    const f = await taskRuntimeCoreFixture(t, {
      compositionPolicy: owner.create,
    });
    await publish(f);
    const before = await f.effects();
    owner.state.onCheck = () => {
      owner.state.onCheck = null;
      queueMicrotask(() => {
        if (change === "withdraw") owner.state.revoked = true;
        else if (change === "scope")
          owner.state.scope = {
            ...f.storage.profile,
            profileId: "foreign-profile",
          };
        else owner.state.epoch = "changed-live-authority-epoch";
      });
    };
    await assert.rejects(
      f.invoke(),
      change === "withdraw"
        ? (error: unknown) =>
            error instanceof ApplicationError &&
            error.code === "extension_service_unavailable" &&
            error.cause instanceof Error &&
            error.cause.message === "named_composition_owner_withdrawn"
        : /installed_plugin_task_composition_authority_changed/,
    );
    assert.deepEqual(await f.effects(), before);
    assert.deepEqual(f.state.accepted, []);
  });
}

test("Core close during composition retrieval rejects before admission and waits for the actual task", async (t) => {
  const owner = policyOwner();
  const f = await taskRuntimeCoreFixture(t, {
    compositionPolicy: owner.create,
  });
  await publish(f);
  const before = await f.effects();
  let closing: Promise<void> | undefined;
  owner.state.onCheck = () => {
    owner.state.onCheck = null;
    queueMicrotask(() => {
      closing = f.core.close();
    });
  };
  await assert.rejects(
    f.invoke(),
    /installed_plugin_request_authority_unavailable/,
  );
  assert.ok(closing);
  await closing;
  assert.deepEqual(await f.effects(), before);
});

test("original request cancellation during composition retrieval does not admit a task", async (t) => {
  const owner = policyOwner();
  const f = await taskRuntimeCoreFixture(t, {
    compositionPolicy: owner.create,
  });
  await publish(f);
  const before = await f.effects();
  const cancellation = new AbortController();
  owner.state.onCheck = () => {
    owner.state.onCheck = null;
    queueMicrotask(() =>
      cancellation.abort(new Error("named_request_canceled")),
    );
  };
  await assert.rejects(f.invoke({ signal: cancellation.signal }));
  assert.deepEqual(await f.effects(), before);
  assert.deepEqual(f.state.accepted, []);
});

test("same-Store reader retains the original historical lock and epoch while current head advances", async (t) => {
  const f = await taskRuntimeCoreFixture(t);
  const original = await publish(f);
  const owner = policyOwner();
  owner.state.epoch = "current-host-authority-epoch";
  const current = await publish(f, owner.state.epoch);
  const reader = createInstalledPluginTaskCompositionReader({
    store: f.storage.first.parent,
    policy: owner.create(f.storage.profile),
    digester: extensionStoreDigester,
    assertActive: () => undefined,
  });
  assert.ok(reader);
  assert.deepEqual(
    await reader.loadCurrent({ scope: f.storage.profile }),
    current.lock,
  );
  const recovered = await reader.loadLock({
    scope: f.storage.profile,
    lockDigest: original.lock.lockDigest,
  });
  assert.deepEqual(recovered, original.lock);
  assert.equal(recovered?.scope.authorityEpoch, epoch);
  await assert.rejects(
    reader.loadCurrent({
      scope: { ...f.storage.profile, profileId: "foreign-profile" },
    }),
    /installed_plugin_task_composition_scope_mismatch/,
  );
  await assert.rejects(
    reader.loadLock({
      scope: { ...f.storage.profile, profileId: "foreign-profile" },
      lockDigest: original.lock.lockDigest,
    }),
    /installed_plugin_task_composition_scope_mismatch/,
  );
  owner.state.revoked = true;
  await assert.rejects(
    reader.loadLock({
      scope: f.storage.profile,
      lockDigest: original.lock.lockDigest,
    }),
    /named_composition_owner_withdrawn/,
  );
});

test("creating a same-Store reader does not migrate missing composition storage", async (t) => {
  const f = await taskRuntimeCoreFixture(t);
  const owner = policyOwner();
  const reader = createInstalledPluginTaskCompositionReader({
    store: f.storage.first.parent,
    policy: owner.create(f.storage.profile),
    digester: extensionStoreDigester,
    assertActive: () => undefined,
  });
  assert.ok(reader);
  await assert.rejects(
    reader.loadCurrent({ scope: f.storage.profile }),
    /no such table: plugin_composition_schema_version/,
  );
});

test("Core refuses malformed or unbound composition policies before obtaining another Store adapter", async (t) => {
  const f = await taskRuntimeCoreFixture(t);
  const owner = policyOwner();
  const valid = owner.create(f.storage.profile);
  let adapters = 0;
  const original = f.storage.first.parent.pluginInstallationStore.bind(
    f.storage.first.parent,
  );
  t.mock.method(f.storage.first.parent, "pluginInstallationStore", () => {
    adapters++;
    return original();
  });
  let getters = 0;
  for (const invalid of [
    { ...valid, schemaVersion: "unsupported" },
    { ...valid, loadCurrent: async () => null },
    { ...valid, assertCurrent: undefined },
    {
      ...valid,
      assertCurrent: () => ({
        ...f.storage.profile,
        authorityEpoch: "foreign-epoch",
      }),
    },
    { ...valid, scope: { ...f.storage.profile, profileId: "foreign-profile" } },
    Object.defineProperty({ ...valid }, "assertCurrent", {
      enumerable: true,
      get() {
        getters++;
        return valid.assertCurrent;
      },
    }),
  ]) {
    await assert.rejects(
      createInstalledPluginTaskRuntimeCore({
        ...f.coreInput,
        compositionPolicy: invalid as InstalledPluginTaskCompositionPolicy,
      }),
    );
    assert.equal(adapters, 0);
  }
  assert.equal(getters, 0);
});
