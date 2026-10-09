import assert from "node:assert/strict";
import test from "node:test";
import { createPluginCompositionLock } from "@crewon/contracts/plugins";
import {
  PluginExecutionComposition,
  PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE as metadata,
} from "./plugin-execution-composition.ts";
import { pluginExecutionPackageFailureOwner } from "./plugin-execution-package.ts";
import {
  compositionFixture,
  scope,
  digester,
  service,
  allow,
} from "./plugin-composition-fixture.test-support.ts";
import {
  executionContext,
  executionRequirement,
  runtimeSource,
} from "./plugin-execution-registry.test-support.ts";

const authority = { ...allow, beforePublication: async () => {} };
async function fixture(t: test.TestContext) {
  const f = await compositionFixture(t);
  const root = await f.make({
    pluginId: "example.root",
    requires: [{ ...service[0]!, optional: false }, executionRequirement],
    setup: `const source=ctx.services.get('story.source','1');ctx.services.get('crewon.execution','1').register({create(input){record('factory-source:'+source.read());return ${runtimeSource}}})`,
  });
  const unrelated = await f.make({
    pluginId: "example.unrelated",
    setup: "throw new Error('unrelated-must-not-load')",
  });
  const lock = f.lock(
    1,
    [f.source.node, root.node, unrelated.node],
    [metadata],
  );
  return {
    ...f,
    root,
    unrelated,
    original: lock,
    async open(
      selected = lock,
      selectedAuthority: Parameters<
        typeof PluginExecutionComposition.open
      >[0]["authority"] = authority,
    ) {
      const owner = await PluginExecutionComposition.open({
        lock: selected,
        expectedScope: scope,
        rootPluginId: root.node.pluginId,
        installRoot: f.installRoot,
        hostServices: [],
        authority: selectedAuthority,
      });
      f.ownOwner(owner);
      return owner;
    },
  };
}
const borrow = (lockDigest: string) => ({
  lockDigest,
  purpose: "historicalOperation" as const,
  authorizeBorrow: () => "allow" as const,
});
const context = (owner: PluginExecutionComposition) => ({
  ...executionContext(owner.identity),
  scope: {
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    profileId: scope.profileId,
  },
});

test("original graph cold-loads its exact old provider beside a new graph and never evaluates unrelated modules", async (t) => {
  const f = await fixture(t);
  const old = await f.open();
  const oldBorrow = old.acquire(borrow(f.original.lockDigest));
  const oldRuntime = await oldBorrow.factory.create(context(old));
  const upgraded = await f.make({
    pluginId: "example.source",
    version: "2.0.0",
    provides: service,
    setup: "ctx.services.provide('story.source','1',{read:()=>2})",
  });
  const next = f.lock(
    2,
    [{ ...upgraded.node, selectionRevision: 2 }, f.root.node, f.unrelated.node],
    [metadata],
  );
  const current = await f.open(next);
  const currentBorrow = current.acquire(borrow(next.lockDigest));
  const currentRuntime = await currentBorrow.factory.create(context(current));
  assert.deepEqual(await f.unrelated.records(), []);
  assert.equal(old.lock.lockDigest, f.original.lockDigest);
  assert.equal(current.lock.lockDigest, next.lockDigest);
  assert.ok((await f.root.records()).includes("factory-source:1"));
  assert.ok((await f.root.records()).includes("factory-source:2"));
  await oldRuntime.close?.();
  await currentRuntime.close?.();
  oldBorrow.release();
  currentBorrow.release();
  await old.close();
  await current.close();
  const restored = await f.open(JSON.parse(JSON.stringify(f.original)));
  const restoredBorrow = restored.acquire(borrow(f.original.lockDigest));
  const restoredRuntime = await restoredBorrow.factory.create(
    context(restored),
  );
  await restoredRuntime.close?.();
  restoredBorrow.release();
  await restored.close();
  assert.equal(
    (await f.root.records()).filter((entry) => entry === "factory-source:1")
      .length,
    2,
  );
  assert.equal(
    (await f.root.records()).filter((entry) => entry === "factory-source:2")
      .length,
    1,
  );
  assert.deepEqual(await f.unrelated.records(), []);
});

test("every authority callback sees the full original lock and actual root setup is joined before post-setup refresh", async (t) => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let rootPublications = 0,
    refreshComplete = false;
  const opening = f.open(f.original, {
    authorizePreparation: ({ lock }) => {
      assert.equal(lock.lockDigest, f.original.lockDigest);
      assert.equal(lock.nodes.length, 3);
      return "allow";
    },
    beforePublication: async ({ lock, node }) => {
      assert.equal(lock.lockDigest, f.original.lockDigest);
      if (node.pluginId === f.root.node.pluginId) {
        assert.ok((await f.root.records()).includes("setup"));
        entered();
        await gate;
        refreshComplete = true;
      }
    },
    authorizePublication: ({ lock, node }) => {
      assert.equal(lock.lockDigest, f.original.lockDigest);
      if (node.pluginId === f.root.node.pluginId) {
        assert.equal(refreshComplete, true);
        rootPublications++;
      }
      return "allow";
    },
  });
  try {
    await started;
    assert.equal(rootPublications, 0);
    release();
    const owner = await opening;
    assert.equal(rootPublications, 1);
    await owner.close();
  } finally {
    release();
    await opening.then(
      (owner) => owner.close(),
      () => {},
    );
  }
});

test("changed post-setup authority prevents a factory from escaping and physically cleans the dependency graph", async (t) => {
  const f = await fixture(t);
  let allowed = true;
  await assert.rejects(
    f.open(f.original, {
      ...authority,
      beforePublication: async ({ node }) => {
        if (node.pluginId === f.root.node.pluginId) allowed = false;
      },
      authorizePublication: () => (allowed ? "allow" : "deny"),
    }),
    /composition_activation_failed/,
  );
  assert.deepEqual(
    (await f.root.records()).filter((entry) =>
      entry.startsWith("factory-source:"),
    ),
    [],
  );
  assert.ok((await f.root.records()).includes("dispose"));
  assert.ok((await f.source.records()).includes("dispose"));
});

test("borrow requires original digest, fresh recovery authority and exact context scope without invoking scope getters", async (t) => {
  const f = await fixture(t),
    owner = await f.open();
  try {
    assert.throws(
      () => owner.acquire(borrow(`sha256:${"0".repeat(64)}`)),
      /borrow_invalid/,
    );
    assert.throws(
      () =>
        owner.acquire({
          ...borrow(f.original.lockDigest),
          authorizeBorrow: () => "deny",
        }),
      /borrow_denied/,
    );
    const lease = owner.acquire(borrow(f.original.lockDigest));
    try {
      const valid = context(owner);
      assert.throws(
        () =>
          lease.factory.create({
            ...valid,
            scope: { ...valid.scope, profileId: "foreign" },
          }),
        /context_scope_conflict/,
      );
      let reads = 0;
      assert.throws(
        () =>
          lease.factory.create({
            ...valid,
            get scope() {
              reads++;
              return valid.scope;
            },
          }),
        /context_scope_conflict/,
      );
      assert.equal(reads, 0);
      assert.deepEqual(
        (await f.root.records()).filter((entry) =>
          entry.startsWith("factory-source:"),
        ),
        [],
      );
      const runtime = await lease.factory.create(valid);
      await runtime.close?.();
    } finally {
      lease.release();
    }
  } finally {
    await owner.close();
  }
});

test("close rejects a live factory lease, keeps dependency ownership, and succeeds only after physical runtime completion", async (t) => {
  const f = await fixture(t),
    owner = await f.open();
  const lease = owner.acquire(borrow(f.original.lockDigest));
  const runtime = await lease.factory.create(context(owner));
  await assert.rejects(owner.close(), /live_leases/);
  assert.ok(!(await f.source.records()).includes("dispose"));
  assert.throws(
    () => owner.acquire(borrow(f.original.lockDigest)),
    /composition_closed/,
  );
  assert.throws(
    () => lease.factory.create(context(owner)),
    /plugin_host_closed/,
  );
  await runtime.close?.();
  lease.release();
  await owner.close();
  assert.equal(
    (await f.source.records()).filter((entry) => entry === "dispose").length,
    1,
  );
});

test("missing root factory cleans all loaded providers and a forged registry implementation cannot load any code", async (t) => {
  const f = await fixture(t);
  const missing = await f.make({
    pluginId: "example.no-factory",
    requires: [executionRequirement, { ...service[0]!, optional: false }],
    setup: "",
  });
  const lock = f.lock(1, [f.source.node, missing.node], [metadata]);
  await assert.rejects(
    PluginExecutionComposition.open({
      lock,
      expectedScope: scope,
      rootPluginId: missing.node.pluginId,
      installRoot: f.installRoot,
      hostServices: [],
      authority,
    }),
    /factory_unavailable/,
  );
  assert.ok((await f.source.records()).includes("dispose"));
  assert.ok((await missing.records()).includes("dispose"));
  const forged = createPluginCompositionLock(
    {
      schemaVersion: f.original.schemaVersion,
      scope,
      revision: 1,
      nodes: f.original.nodes,
      hostServices: [{ ...metadata, implementationId: "unapproved" }],
    },
    digester,
  );
  await assert.rejects(f.open(forged), /host_service_conflict/);
  assert.deepEqual(await f.root.records(), []);
});

test("failed graph cleanup retains an actual retry owner; matching error text cannot claim it", async (t) => {
  const f = await fixture(t);
  const broken = await f.make({
    pluginId: "example.broken-provider",
    provides: service,
    setup:
      "ctx.services.provide('story.source','1',{read:()=>1});ctx.onDispose(()=>{throw new Error('fixture-cleanup-failure')})",
  });
  const lock = f.lock(1, [broken.node, f.root.node], [metadata]);
  let failed: unknown;
  try {
    await f.open(lock, {
      ...authority,
      authorizePublication: ({ node }) =>
        node.pluginId === f.root.node.pluginId ? "deny" : "allow",
    });
    assert.fail("denied startup must reject");
  } catch (error) {
    failed = error;
  }
  assert.ok(failed instanceof AggregateError);
  assert.match(failed.message, /composition_start_failed/);
  const owner = pluginExecutionPackageFailureOwner(failed);
  assert.ok(owner);
  assert.equal(
    pluginExecutionPackageFailureOwner(new Error(failed.message)),
    null,
  );
  await assert.rejects(owner.close(), /cleanup_failed/);
  assert.equal(
    (await broken.records()).filter((entry) => entry === "setup").length,
    1,
  );
});

test("the authenticated original scope is checked independently before any graph code or authorization callback", async (t) => {
  const f = await fixture(t);
  let authorizations = 0;
  for (const field of [
    "tenantId",
    "spaceId",
    "profileId",
    "authorityEpoch",
  ] as const) {
    await assert.rejects(
      PluginExecutionComposition.open({
        lock: f.original,
        expectedScope: { ...scope, [field]: "foreign" },
        rootPluginId: f.root.node.pluginId,
        installRoot: f.installRoot,
        hostServices: [],
        authority: {
          ...authority,
          authorizePreparation: () => {
            authorizations++;
            return "allow";
          },
        },
      }),
      /composition_scope_conflict/,
    );
  }
  const foreign = createPluginCompositionLock(
    {
      schemaVersion: f.original.schemaVersion,
      scope: { ...scope, tenantId: "foreign" },
      revision: 1,
      nodes: f.original.nodes,
      hostServices: f.original.hostServices,
    },
    digester,
  );
  await assert.rejects(f.open(foreign), /composition_scope_conflict/);
  assert.equal(authorizations, 0);
  assert.deepEqual(await f.root.records(), []);
  assert.deepEqual(await f.source.records(), []);
});

test("an unrelated old host service need not be revived, and fresh absent optional services cannot enter the original root closure", async (t) => {
  const f = await fixture(t);
  const original = f.lock(1, f.original.nodes, [
    metadata,
    {
      service: "host.unused",
      apiVersion: "1",
      implementationId: "removed-host-module",
      implementationRevision: 1,
    },
  ]);
  const owner = await f.open(original);
  const lease = owner.acquire(borrow(original.lockDigest));
  const runtime = await lease.factory.create(context(owner));
  assert.equal(
    owner.lock.hostServices.length,
    2,
    "the original audit lock remains complete",
  );
  await runtime.close?.();
  lease.release();
  await owner.close();
  const optional = await f.make({
    pluginId: "example.optional-root",
    requires: [
      executionRequirement,
      { service: "host.later", apiVersion: "1", optional: true },
    ],
    setup: `const later=ctx.services.getOptional('host.later','1');record(later===undefined?'captured-absent':'unexpected-service');ctx.services.get('crewon.execution','1').register({create(input){return ${runtimeSource}}})`,
  });
  const absent = f.lock(2, [optional.node], [metadata]);
  let bindingCalls = 0;
  const restored = await PluginExecutionComposition.open({
    lock: absent,
    expectedScope: scope,
    rootPluginId: optional.node.pluginId,
    installRoot: f.installRoot,
    hostServices: [
      {
        metadata: {
          service: "host.later",
          apiVersion: "1",
          implementationId: "new-host-module",
          implementationRevision: 1,
        },
        implementation: {
          service: "host.later",
          apiVersion: "1",
          value: {},
          bindForPlugin() {
            bindingCalls++;
            return {};
          },
        },
      },
    ],
    authority,
  });
  f.ownOwner(restored);
  assert.equal(bindingCalls, 0);
  assert.ok((await optional.records()).includes("captured-absent"));
  await restored.close();
});
