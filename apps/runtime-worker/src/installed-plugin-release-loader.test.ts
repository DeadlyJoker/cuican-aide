import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { compileAgentVersion } from "@crewon/agent-version";
import { createAgentVersionAsset } from "@crewon/agent-version";
import {
  AgentVersionReleaseApplicationService,
  compileAgentVersionReleaseBundle,
} from "@crewon/application";
import { SqliteRunStore } from "@crewon/store";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { ConfiguredAgentVersionRuntimeFactory } from "./configured-agent-version-runtime-factory.ts";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import {
  readInstalledPluginAgentRuntimeScope,
  installedPluginAgentRuntimeTarget,
} from "./plugins/installed-plugin-agent-runtime-factory.ts";
import { compileInstalledPluginAgentVersion } from "./plugins/installed-plugin-agent-version.ts";
import { guardInstalledPluginReleaseFactory } from "./plugins/installed-plugin-release-factory.ts";
import { InstalledPluginReleaseLifetime } from "./plugins/installed-plugin-release-lifetime.ts";
import {
  assertLoadedInstalledPluginRelease,
  composeInstalledPluginReleaseRuntimeFactory,
  loadInstalledPluginRelease,
  verifyInstalledPluginRelease,
} from "./plugins/installed-plugin-release-loader.ts";
import {
  digester,
  installedReleaseFixture,
  pgOptions,
  releaseActor,
  timestamp,
} from "./installed-plugin-release-loader.test-support.ts";

test("actual installed SDK packages are read without provider/Node creation and copied Loaded records are not authority", async (t) => {
  const f = await installedReleaseFixture(t, "sqlite", { versions: 2 });
  const release = await loadInstalledPluginRelease(f.loaderInput);
  assertLoadedInstalledPluginRelease(release);
  assert.throws(
    () => assertLoadedInstalledPluginRelease({ ...release }),
    /unverified_document/,
  );
  assert.deepEqual(
    release.versions,
    f.entries.map((entry) => entry.version),
  );
  assert.deepEqual(
    release.registrations.map((registration) => registration.identity),
    f.entries.map((entry) => entry.packageIdentity),
  );
  assert.equal(f.state.metadataReads, 2);
  let released = 0;
  await assert.rejects(
    release.factory.create({
      tenantId: releaseActor.tenantId,
      version: release.versions[0]!,
      failedCreationCleanup: {
        confirmReleased() {
          released++;
        },
      },
    }),
    /publication_unverified/,
  );
  assert.equal(
    released,
    1,
    "allocation-free publication failure releases its actual capacity reservation",
  );
  assert.equal(
    await f.store.loadAgentVersion({
      tenantId: releaseActor.tenantId,
      agentVersionId: f.baseVersion.agentVersionId,
    }),
    null,
  );
});

test("actual byte permission, base materialization digest, compiled version and target are independently checked", async (t) => {
  const f = await installedReleaseFixture(t);
  f.state.allowed = false;
  await assert.rejects(loadInstalledPluginRelease(f.loaderInput));
  f.state.allowed = true;
  const baseDrift = structuredClone(f.document);
  Reflect.set(
    baseDrift.entries[0]!.modelSource.deployment,
    "materializationDigest",
    digester.sha256("unrelated-model"),
  );
  await assert.rejects(
    loadInstalledPluginRelease({ ...f.loaderInput, document: baseDrift }),
    /model_source_mismatch/,
  );
  const targetDrift = structuredClone(f.document);
  Reflect.set(
    targetDrift.entries[0]!.target,
    "materializationDigest",
    digester.sha256("unrelated-target"),
  );
  await assert.rejects(
    loadInstalledPluginRelease({ ...f.loaderInput, document: targetDrift }),
    /target_mismatch/,
  );
  const wrongVersion = structuredClone(f.document),
    original = wrongVersion.entries[0]!.version;
  const { contentDigest: _, ...body } = original;
  const changed = compileAgentVersion(
    {
      ...body,
      schemaVersion: "crewon.agent-version-source.v0",
      instructions: "A package cannot replace host instructions.",
    },
    digester,
  );
  Reflect.set(wrongVersion.entries[0], "version", changed);
  Reflect.set(
    wrongVersion.entries[0]!.target,
    "agentVersionContentDigest",
    changed.contentDigest,
  );
  await assert.rejects(
    loadInstalledPluginRelease({ ...f.loaderInput, document: wrongVersion }),
    /version_mismatch/,
  );
});

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: real published parent Store materializes pinned historical versions and preserves the original default`,
    backend === "postgres" ? pgOptions : {},
    async (t) => {
      const f = await installedReleaseFixture(t, backend, { versions: 2 });
      const release = await f.publish();
      await verifyInstalledPluginRelease({ release, store: f.store });
      const baseFactory = new ConfiguredAgentVersionRuntimeFactory([f.base]);
      const factory = composeInstalledPluginReleaseRuntimeFactory({
        release,
        base: { factory: baseFactory, deployments: [f.baseDeployment] },
      });
      const registry = new InMemoryAgentVersionRuntimeRegistry(digester);
      const defaultRuntime = await baseFactory.create({
        tenantId: releaseActor.tenantId,
        version: f.baseVersion,
      });
      registry.register({
        tenantId: releaseActor.tenantId,
        runtime: defaultRuntime,
      });
      const resolver = new StoreBackedAgentVersionRuntimeResolver({
        store: f.store,
        digester,
        registry,
        factory,
      });
      f.own({
        async close() {
          resolver.close();
          await registry.close();
        },
      });
      const baseline = await resolver.acquire({
        tenantId: releaseActor.tenantId,
        agentVersionId: f.baseVersion.agentVersionId,
      });
      assert.ok(baseline);
      assert.equal(baseline.resource, defaultRuntime);
      baseline.release();
      for (const expected of f.entries) {
        const lease = await resolver.acquire({
          tenantId: releaseActor.tenantId,
          agentVersionId: expected.version.agentVersionId,
        });
        assert.ok(lease);
        assert.deepEqual(lease.resource.version, expected.version);
        assert.deepEqual(
          lease.resource.extensions?.[0]?.target,
          expected.target,
        );
        assert.deepEqual(
          readInstalledPluginAgentRuntimeScope(lease.resource),
          expected.scope,
        );
        assert.deepEqual(
          lease.resource.toolRuntime.definitions(),
          expected.version.tools,
        );
        assert.equal(
          lease.resource.kernel.modelIdentity.modelId,
          f.baseVersion.model.modelId,
        );
        assert.equal(
          lease.resource.toolRuntime.executionPolicy(
            "function",
            expected.version.tools[0]!.name,
          ),
          null,
          "placeholder never claims installed SDK execution readiness",
        );
        lease.release();
      }
      assert.deepEqual(defaultRuntime.version, f.baseVersion);
      assert.deepEqual(defaultRuntime.toolRuntime.definitions(), []);
      assert.deepEqual(
        factory
          .deploymentBindings(releaseActor.tenantId)
          .map((entry) => entry.agentVersionId),
        [
          f.entries[0]!.version.agentVersionId,
          f.entries[1]!.version.agentVersionId,
          f.baseVersion.agentVersionId,
        ],
      );
      assert.equal(
        (
          await f.store.loadActiveAgentVersionRelease({
            tenantId: releaseActor.tenantId,
          })
        )?.bundle.defaultAgentVersionId,
        f.baseVersion.agentVersionId,
      );
    },
  );
  test(
    `${backend}: cold parent Store reload keeps A after B selection and disabled history without opening the latest package`,
    backend === "postgres" ? pgOptions : {},
    async (t) => {
      const f = await installedReleaseFixture(t, backend, { versions: 2 });
      await f.publish();
      const scope = f.entries[0]!.scope;
      const installations = f.store.pluginInstallationStore();
      const current = await installations.loadSelection({
        scope,
        pluginId: f.entries[0]!.packageIdentity.pluginId,
      });
      assert.ok(current);
      await installations.commitSelection({
        scope,
        actor: releaseActor,
        expectedSelectionRevision: current.revision,
        selection: {
          ...current,
          revision: current.revision + 1,
          selectedPackageDigest: f.entries[1]!.packageIdentity.packageDigest,
          state: "disabled",
          updatedAt: timestamp,
          updatedByActorId: releaseActor.actorId,
          updatedByPrincipalId: releaseActor.principalId,
        },
        receipt: {
          idempotencyKey: "select-current-B-disabled",
          requestDigest: digester.sha256("select-current-B-disabled"),
        },
      });
      await f.reopenStore();
      const release = await loadInstalledPluginRelease(f.loaderInput);
      await verifyInstalledPluginRelease({ release, store: f.store });
      const runtime = await release.factory.create({
        tenantId: releaseActor.tenantId,
        version: f.entries[0]!.version,
      });
      try {
        assert.equal(
          runtime.extensions?.[0]?.configuration.pluginVersion,
          "1.0.0",
        );
        assert.deepEqual(runtime.extensions?.[0]?.target, f.entries[0]!.target);
        assert.equal(
          (
            await f.store.pluginInstallationStore().loadSelection({
              scope,
              pluginId: f.entries[0]!.packageIdentity.pluginId,
            })
          )?.selectedPackageDigest,
          f.entries[1]!.packageIdentity.packageDigest,
        );
      } finally {
        await runtime.close?.();
      }
    },
  );
}

test("missing publication and wrong original deployment cannot authorize a factory", async (t) => {
  const f = await installedReleaseFixture(t);
  const release = await loadInstalledPluginRelease(f.loaderInput);
  await assert.rejects(
    verifyInstalledPluginRelease({ release, store: f.store }),
    /asset_missing/,
  );
  await assert.rejects(
    release.factory.create({
      tenantId: releaseActor.tenantId,
      version: release.versions[0]!,
    }),
    /publication_unverified/,
  );
  const badPublished = await f.publish({
    baseDeployment: {
      ...f.baseDeployment,
      materializationDigest: digester.sha256("another-original-deployment"),
    },
  });
  await assert.rejects(
    verifyInstalledPluginRelease({ release: badPublished, store: f.store }),
    /deployment_mismatch/,
  );
});

test("a real published scoped deployment cannot borrow another profile's installed ledger", async (t) => {
  const f = await installedReleaseFixture(t),
    original = await f.publish();
  const entry = f.entries[0]!,
    scope = { ...entry.scope, profileId: "another-profile" };
  const registration = original.registrations[0]!;
  const version = compileInstalledPluginAgentVersion({
    base: { executionAuthority: "crewonKernel", version: f.baseVersion },
    registration,
    agentVersionId: "another-profile-agent",
    runtimeGeneration: entry.version.runtimeGeneration,
    policySnapshotId: entry.version.policySnapshotId,
    digester,
  });
  const target = installedPluginAgentRuntimeTarget({
    defaultAgentVersionId: f.baseVersion.agentVersionId,
    entry: {
      scope,
      registration,
      configuration: entry.configuration,
      approvalRequirement: entry.approvalRequirement,
      base: {
        executionAuthority: "crewonKernel",
        version: f.baseVersion,
        deployment: f.baseDeployment,
      },
      version,
      authorityId: f.base.authorityId,
      workspaceBindingId: f.base.workspaceBindingId,
      transportOwnership: f.base.transportOwnership,
      createTransport: f.base.createTransport,
      createBaseToolRuntime: f.base.createToolRuntime,
    },
  });
  const document = {
    ...f.document,
    entries: [{ ...entry, scope, version, target }],
  };
  const release = await loadInstalledPluginRelease({
    ...f.loaderInput,
    document,
    async authorizeRead(request) {
      assert.deepEqual(request.scope, scope);
      return "allow";
    },
  });
  f.own(release);
  await f.store.registerAgentVersion(
    createAgentVersionAsset({
      tenantId: releaseActor.tenantId,
      version,
      createdAt: timestamp,
    }),
  );
  const active = await f.store.loadActiveAgentVersionRelease({
    tenantId: releaseActor.tenantId,
  });
  assert.ok(active);
  const bundle = compileAgentVersionReleaseBundle(
    {
      ...active.bundle,
      deployments: [...active.bundle.deployments, ...release.deployments],
    },
    digester,
  );
  await new AgentVersionReleaseApplicationService({
    store: f.store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => timestamp },
    digester,
  }).activate(releaseActor, bundle, "publish-another-profile");
  await assert.rejects(
    verifyInstalledPluginRelease({ release, store: f.store }),
    /package_missing/,
  );
  await assert.rejects(
    release.factory.create({ tenantId: releaseActor.tenantId, version }),
    /publication_unverified/,
  );
});

test("each creation rechecks actual installed bytes, current read authority and bound parent Store", async (t) => {
  const f = await installedReleaseFixture(t);
  const release = await f.publish();
  await verifyInstalledPluginRelease({ release, store: f.store });
  const second = new SqliteRunStore(":memory:");
  t.after(() => second.close());
  await assert.rejects(
    verifyInstalledPluginRelease({ release, store: second }),
    /store_owner_mismatch/,
  );
  f.state.allowed = false;
  let cleaned = 0;
  await assert.rejects(
    release.factory.create({
      tenantId: releaseActor.tenantId,
      version: release.versions[0]!,
      failedCreationCleanup: {
        confirmReleased() {
          cleaned++;
        },
      },
    }),
  );
  assert.equal(cleaned, 1);
  f.state.allowed = true;
  const node = join(f.packages[0]!.directory, "node.mjs");
  await chmod(node, 0o600);
  await writeFile(node, "throw new Error('tampered code must never load');");
  await chmod(node, 0o444);
  await assert.rejects(
    release.factory.create({
      tenantId: releaseActor.tenantId,
      version: release.versions[0]!,
    }),
  );
});

test("exact composite factory dispatch preserves shared ownership and never falls back after an installed failure", async (t) => {
  const f = await installedReleaseFixture(t),
    release = await f.publish();
  await verifyInstalledPluginRelease({ release, store: f.store });
  let baseCalls = 0;
  const shared = new InMemoryToolBroker();
  const baseFactory = new ConfiguredAgentVersionRuntimeFactory([
    {
      ...f.base,
      toolRuntimeMode: "shared",
      createToolRuntime() {
        baseCalls++;
        throw new Error("shared creator must not run");
      },
    },
  ]);
  const composite = composeInstalledPluginReleaseRuntimeFactory({
    release,
    base: { factory: baseFactory, deployments: [f.baseDeployment] },
  });
  const bound = composite.bindSharedToolRuntime!(shared);
  assert.equal(bound.sharedResourceOwner, shared);
  assert.equal(
    bound.runtimeOwnership!({
      tenantId: releaseActor.tenantId,
      version: f.baseVersion,
    }),
    "sharedProjection",
  );
  assert.equal(
    bound.runtimeOwnership!({
      tenantId: releaseActor.tenantId,
      version: release.versions[0]!,
    }),
    "ownedRuntime",
  );
  const baseline = await bound.create({
    tenantId: releaseActor.tenantId,
    version: f.baseVersion,
  });
  assert.equal(baseline.close, undefined);
  f.state.allowed = false;
  await assert.rejects(async () =>
    bound.create({
      tenantId: releaseActor.tenantId,
      version: release.versions[0]!,
    }),
  );
  assert.equal(baseCalls, 0);
  assert.throws(
    () =>
      composeInstalledPluginReleaseRuntimeFactory({
        release,
        base: { factory: baseFactory, deployments: release.deployments },
      }),
    /factory_conflict/,
  );
  let released = 0;
  await assert.rejects(
    async () =>
      composite.create({
        tenantId: "another-tenant",
        version: release.versions[0]!,
        failedCreationCleanup: {
          confirmReleased() {
            released++;
          },
        },
      }),
    /factory_missing/,
  );
  assert.equal(released, 1);
});

test("release shutdown withdraws queued creation synchronously and confirms allocation-free capacity", async (t) => {
  const f = await installedReleaseFixture(t),
    release = await f.publish();
  await verifyInstalledPluginRelease({ release, store: f.store });
  let cleaned = 0;
  const creation = release.factory.create({
    tenantId: releaseActor.tenantId,
    version: release.versions[0]!,
    failedCreationCleanup: {
      confirmReleased() {
        cleaned++;
      },
    },
  });
  const close = release.close();
  assert.equal(release.close(), close);
  await assert.rejects(creation, /closed/);
  await close;
  assert.equal(cleaned, 1);
  await assert.rejects(
    async () =>
      release.factory.create({
        tenantId: releaseActor.tenantId,
        version: release.versions[0]!,
      }),
    /closed/,
  );
  assert.ok(
    await f.store.loadAgentVersion({
      tenantId: releaseActor.tenantId,
      agentVersionId: f.baseVersion.agentVersionId,
    }),
  );
});

test("release shutdown cancels metadata permission and joins its real pending callback before parent Store close", async (t) => {
  const f = await installedReleaseFixture(t);
  await f.publish();
  let blocked = false;
  let entered!: () => void, finish!: () => void;
  const admission = new Promise<void>((resolve) => (entered = resolve));
  const physical = new Promise<void>((resolve) => (finish = resolve));
  let metadataSignal: AbortSignal | null = null;
  const release = await loadInstalledPluginRelease({
    ...f.loaderInput,
    async authorizeRead(_request, signal) {
      if (blocked) {
        metadataSignal = signal;
        entered();
        await physical;
      }
      return "allow";
    },
  });
  await verifyInstalledPluginRelease({ release, store: f.store });
  blocked = true;
  const creation = release.factory.create({
    tenantId: releaseActor.tenantId,
    version: release.versions[0]!,
  });
  const failed = assert.rejects(creation, /closed/);
  await admission;
  let closed = false;
  const closing = release.close();
  void closing.then(() => (closed = true));
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal((metadataSignal as AbortSignal | null)?.aborted, true);
  assert.ok(
    await f.store.loadAgentVersion({
      tenantId: releaseActor.tenantId,
      agentVersionId: f.baseVersion.agentVersionId,
    }),
  );
  finish();
  await failed;
  await closing;
});

test("shutdown joins an already started real factory and returns its late resource to the actual caller", async (t) => {
  const f = await installedReleaseFixture(t),
    release = await f.publish();
  await verifyInstalledPluginRelease({ release, store: f.store });
  let entered!: () => void, finish!: () => void;
  const starting = new Promise<void>((resolve) => (entered = resolve));
  const physical = new Promise<void>((resolve) => (finish = resolve));
  let resourceCloses = 0;
  const transport = {
    adapterName: f.baseVersion.model.adapterName,
    adapterVersion: f.baseVersion.model.adapterVersion,
    modelId: f.baseVersion.model.modelId,
    maxOutputTokens: f.baseVersion.model.maxOutputTokens,
    async *stream() {
      throw new Error("lifecycle fixture never sends a model request");
    },
    async prewarm() {
      entered();
      await physical;
    },
    async close() {
      resourceCloses++;
    },
  };
  const lifetime = new InstalledPluginReleaseLifetime();
  f.own(lifetime);
  const actual = new ConfiguredAgentVersionRuntimeFactory([
    {
      ...f.base,
      transportOwnership: "runtime",
      createTransport: () => transport,
    },
  ]);
  const guarded = guardInstalledPluginReleaseFactory({
    factory: actual,
    lifetime,
    verifyCreation: async () =>
      verifyInstalledPluginRelease({ release, store: f.store }),
  });
  const creation = guarded.create({
    tenantId: releaseActor.tenantId,
    version: f.baseVersion,
  });
  await starting;
  let closed = false;
  const closing = lifetime.close();
  void closing.then(() => (closed = true));
  await Promise.resolve();
  assert.equal(closed, false);
  finish();
  const runtime = await creation;
  await closing;
  assert.equal(
    resourceCloses,
    0,
    "release metadata owner must not drop or silently dispose the returned actual runtime",
  );
  assert.equal(
    runtime.kernel.modelIdentity.modelId,
    f.baseVersion.model.modelId,
  );
  await runtime.close?.();
  assert.equal(resourceCloses, 1);
});
