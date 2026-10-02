import assert from "node:assert/strict";
import { open, type FileHandle } from "node:fs/promises";
import test from "node:test";
import {
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import { SqliteRunStore } from "@crewon/store";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { createExtensionConfiguration } from "@crewon/domain";
import {
  createInstalledPluginAgentVersionRuntimeFactory,
  installedPluginAgentRuntimeTarget,
  readInstalledPluginAgentRuntimeScope,
  installedPluginAgentRuntimeFailureOwner,
} from "./plugins/installed-plugin-agent-runtime-factory.ts";
import { ConfiguredAgentVersionRuntimeFactory } from "./configured-agent-version-runtime-factory.ts";
import { AgentRuntimeCapacity } from "./agent-runtime-capacity.ts";
import { createAdmittedAgentRuntime } from "./admitted-agent-runtime-creation.ts";
import {
  InMemoryAgentVersionRuntimeRegistry,
  validateAgentVersionRuntime,
} from "./agent-version-runtime.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import { readRuntimeExtensionMaterializations } from "./extensions/extension-runtime-proof.ts";
import { extensionToolDefinitions } from "./extensions/extension-tool-catalog.ts";
import {
  baseSource,
  baseTool,
  command,
  digester,
  factoryFixture,
  rebind,
  scope,
} from "./installed-plugin-agent-runtime-factory.test-support.ts";

test("materializes actual installed enterprise metadata through the existing Kernel and owned tool factory", async (t) => {
  const f = await factoryFixture(t);
  const before = structuredClone(f.entry.base.version);
  const factory = createInstalledPluginAgentVersionRuntimeFactory({
    defaultAgentVersionId: before.agentVersionId,
    entries: [f.entry],
  });
  const target = installedPluginAgentRuntimeTarget({
    defaultAgentVersionId: before.agentVersionId,
    entry: f.entry,
  });
  assert.equal(
    factory.deploymentBindings(scope.tenantId)[0]!.materializationDigest,
    target.materializationDigest,
  );
  assert.equal(factory.deploymentBindings(scope.tenantId).length, 1);
  assert.equal(
    factory.deploymentBindings(scope.tenantId)[0]!.agentVersionId,
    f.entry.version.agentVersionId,
  );
  const runtime = await factory.create({
    tenantId: scope.tenantId,
    version: f.entry.version,
  });
  validateAgentVersionRuntime(runtime, digester);
  assert.deepEqual(runtime.kernel.modelIdentity, {
    adapterName: before.model.adapterName,
    adapterVersion: before.model.adapterVersion,
    modelId: before.model.modelId,
  });
  assert.deepEqual(runtime.toolRuntime.definitions(), f.entry.version.tools);
  assert.deepEqual(runtime.version.tools, [
    baseTool,
    ...extensionToolDefinitions(f.entry.registration.manifest),
  ]);
  assert.ok(
    runtime.version.instructions?.includes(
      f.entry.registration.manifest.task.instructions,
    ),
  );
  assert.ok(
    runtime.version.tools.every((tool) => !tool.name.includes("comfy")),
  );
  assert.deepEqual(f.entry.base.version, before);
  assert.deepEqual(readInstalledPluginAgentRuntimeScope(runtime), scope);
  assert.deepEqual(runtime.extensions?.[0]?.target, target);
  assert.deepEqual(Object.keys(runtime.extensions![0]!.registration).sort(), [
    "implementationDigest",
    "manifest",
    "manifestDigest",
  ]);
  // Composite sorting requires a scoped projection; the attestation belongs to the actual runtime.
  assert.equal(readRuntimeExtensionMaterializations(runtime.toolRuntime), null);
  assert.throws(
    () => readInstalledPluginAgentRuntimeScope({ ...runtime }),
    /scope_unverified/,
  );
  await runtime.close?.();
  await runtime.close?.();
  assert.equal(f.state.baseCloses, 1);
  assert.equal(f.state.transportCloses, 1);
});

test("plugin catalog placeholder rejects every provider operation without an SDK owner", async (t) => {
  const f = await factoryFixture(t);
  const factory = createInstalledPluginAgentVersionRuntimeFactory({
    defaultAgentVersionId: f.entry.base.version.agentVersionId,
    entries: [f.entry],
  });
  const runtime = await factory.create({
    tenantId: scope.tenantId,
    version: f.entry.version,
  });
  const name = extensionToolDefinitions(f.entry.registration.manifest)[0]!.name;
  assert.equal(runtime.toolRuntime.executionPolicy("function", name), null);
  const request = { ...command(), name };
  for (const method of ["execute", "reconcile", "cancel"] as const)
    await assert.rejects(
      runtime.toolRuntime[method](request, new AbortController().signal),
      /installed_plugin_sdk_runtime_required/,
    );
  assert.equal(f.state.baseCalls, 0);
  assert.equal(runtime.canRetire?.(), false); // Runtime-owned fixture transport is not a request transport.
  await runtime.close?.();
});

test("keeps host tool behavior and tool order while adding a plugin catalog", async (t) => {
  const f = await factoryFixture(t);
  const runtime = await createInstalledPluginAgentVersionRuntimeFactory({
    defaultAgentVersionId: f.entry.base.version.agentVersionId,
    entries: [f.entry],
  }).create({ tenantId: scope.tenantId, version: f.entry.version });
  let request = { ...command(), name: baseTool.name };
  request = rebind(request, {
    tool: { ...request.actionIntent.tool, name: baseTool.name },
  });
  const result = await runtime.toolRuntime.execute(
    request,
    new AbortController().signal,
  );
  assert.equal(result.status, "completed");
  assert.equal(
    result.status === "completed" ? result.result.output : null,
    "host-original",
  );
  assert.equal(f.state.baseCalls, 1);
  await runtime.close?.();
});

test("binds full profile, original base materialization, configuration and approval to the target digest", async (t) => {
  const f = await factoryFixture(t);
  const original = installedPluginAgentRuntimeTarget({
    defaultAgentVersionId: f.entry.base.version.agentVersionId,
    entry: f.entry,
  });
  const nextConfig = createExtensionConfiguration(
    { ...f.entry.configuration, revision: 2 },
    digester,
  );
  for (const entry of [
    { ...f.entry, scope: { ...scope, profileId: "profile-2" } },
    {
      ...f.entry,
      base: {
        ...f.entry.base,
        deployment: {
          ...f.entry.base.deployment,
          materializationDigest: digester.sha256(
            "different actual base resources",
          ),
        },
      },
    },
    { ...f.entry, configuration: nextConfig },
    { ...f.entry, approvalRequirement: "perAction" as const },
    { ...f.entry, authorityId: "changed-authority" },
  ])
    assert.notEqual(
      installedPluginAgentRuntimeTarget({
        defaultAgentVersionId: f.entry.base.version.agentVersionId,
        entry,
      }).materializationDigest,
      original.materializationDigest,
    );
});

test("refuses default replacement, unverified registration, mismatched scopes and a changed derived Agent before allocation", async (t) => {
  const f = await factoryFixture(t);
  const version = compileAgentVersion(
    { ...baseSource(), agentVersionId: f.entry.version.agentVersionId },
    digester,
  );
  const cases = [
    { ...f.entry, registration: { ...f.entry.registration } },
    { ...f.entry, scope: { ...scope, spaceId: "space-2" } },
    {
      ...f.entry,
      base: {
        ...f.entry.base,
        deployment: { ...f.entry.base.deployment, tenantId: "tenant-2" },
      },
    },
    {
      ...f.entry,
      base: {
        ...f.entry.base,
        deployment: {
          ...f.entry.base.deployment,
          contentDigest: digester.sha256("wrong base content"),
        },
      },
    },
    { ...f.entry, version },
  ];
  for (const entry of cases)
    assert.throws(() =>
      createInstalledPluginAgentVersionRuntimeFactory({
        defaultAgentVersionId: f.entry.base.version.agentVersionId,
        entries: [entry],
      }),
    );
  assert.throws(
    () =>
      createInstalledPluginAgentVersionRuntimeFactory({
        defaultAgentVersionId: f.entry.version.agentVersionId,
        entries: [f.entry],
      }),
    /default_conflict/,
  );
  assert.throws(
    () =>
      createInstalledPluginAgentVersionRuntimeFactory({
        defaultAgentVersionId: f.entry.base.version.agentVersionId,
        entries: [
          f.entry,
          { ...f.entry, scope: { ...scope, profileId: "profile-2" } },
        ],
      }),
    /binding_duplicate|binding_conflict/,
  );
  assert.equal(f.state.transports, 0);
  assert.equal(f.state.baseTools, 0);
});

test("revalidates real package authority before allocating a provider or any base tools", async (t) => {
  const f = await factoryFixture(t);
  const factory = createInstalledPluginAgentVersionRuntimeFactory({
    defaultAgentVersionId: f.entry.base.version.agentVersionId,
    entries: [f.entry],
  });
  f.state.allowed = false;
  let confirmed = 0;
  await assert.rejects(
    factory.create({
      tenantId: scope.tenantId,
      version: f.entry.version,
      failedCreationCleanup: {
        confirmReleased() {
          confirmed++;
        },
      },
    }),
    /read_denied/,
  );
  assert.equal(f.state.transports, 0);
  assert.equal(f.state.baseTools, 0);
  assert.equal(confirmed, 1);
});

test("permission revoked while base allocation waits closes both owners and never publishes proof", async (t) => {
  const f = await factoryFixture(t);
  f.state.onBaseCreate = async () => {
    f.state.allowed = false;
  };
  const factory = createInstalledPluginAgentVersionRuntimeFactory({
    defaultAgentVersionId: f.entry.base.version.agentVersionId,
    entries: [f.entry],
  });
  let confirmed = 0;
  await assert.rejects(
    factory.create({
      tenantId: scope.tenantId,
      version: f.entry.version,
      failedCreationCleanup: {
        confirmReleased() {
          confirmed++;
        },
      },
    }),
    /read_denied/,
  );
  assert.equal(f.state.baseCloses, 1);
  assert.equal(f.state.transportCloses, 1);
  assert.equal(confirmed, 1);
});

test("base catalog drift cleans up materializers and cannot become an installed proof", async (t) => {
  const f = await factoryFixture(t);
  f.state.baseCatalog = [
    { ...baseTool, description: "Drifted implementation" },
  ];
  const factory = createInstalledPluginAgentVersionRuntimeFactory({
    defaultAgentVersionId: f.entry.base.version.agentVersionId,
    entries: [f.entry],
  });
  await assert.rejects(
    factory.create({ tenantId: scope.tenantId, version: f.entry.version }),
    /base_tools_mismatch/,
  );
  assert.equal(f.state.baseCloses, 1);
  assert.equal(f.state.transportCloses, 1);
});

test("failed base cleanup preserves the construction error and never confirms released capacity", async (t) => {
  const f = await factoryFixture(t);
  f.state.baseCatalog = [
    { ...baseTool, description: "Drifted implementation" },
  ];
  f.state.baseCloseFails = true;
  const factory = createInstalledPluginAgentVersionRuntimeFactory({
    defaultAgentVersionId: f.entry.base.version.agentVersionId,
    entries: [f.entry],
  });
  let confirmed = 0;
  await assert.rejects(
    factory.create({
      tenantId: scope.tenantId,
      version: f.entry.version,
      failedCreationCleanup: {
        confirmReleased() {
          confirmed++;
        },
      },
    }),
    /base_tools_mismatch/,
  );
  assert.equal(confirmed, 0);
  assert.equal(f.state.baseCloses, 1);
  assert.equal(f.state.transportCloses, 1);
});

test("idle retirement requires the real base owner proof and keeps legacy owners without a profile claim", async (t) => {
  const f = await factoryFixture(t);
  const original = await f.baseFactory.create({
    tenantId: scope.tenantId,
    version: f.entry.base.version,
  });
  assert.equal(readInstalledPluginAgentRuntimeScope(original), null);
  await original.close?.();
  const entry = {
    ...f.entry,
    transportOwnership: "request" as const,
    createTransport() {
      return {
        ...f.entry.version.model,
        async *stream() {
          yield { type: "completed" as const, checkpoint: null };
        },
      };
    },
  };
  const runtime = await createInstalledPluginAgentVersionRuntimeFactory({
    defaultAgentVersionId: entry.base.version.agentVersionId,
    entries: [entry],
  }).create({ tenantId: scope.tenantId, version: entry.version });
  assert.equal(runtime.canRetire?.(), true);
  await runtime.close?.();
  assert.equal(runtime.canRetire?.(), false);
  assert.equal(f.state.baseCloses, 2);
});

test("durable StoreBacked creation preserves the same actual profile attestation, including shared-owner binding", async (t) => {
  const f = await factoryFixture(t);
  const store = new SqliteRunStore(`${f.directory}/runtime.sqlite`);
  const registry = new InMemoryAgentVersionRuntimeRegistry(digester);
  let resolver: StoreBackedAgentVersionRuntimeResolver | null = null;
  t.after(async () => {
    resolver?.close();
    await registry.close();
    await store.close();
  });
  await store.registerAgentVersion(
    createAgentVersionAsset({
      tenantId: scope.tenantId,
      version: f.entry.version,
      createdAt: "2026-10-03T00:00:00.000Z",
    }),
  );
  const installed = createInstalledPluginAgentVersionRuntimeFactory({
    defaultAgentVersionId: f.entry.base.version.agentVersionId,
    entries: [f.entry],
  });
  const factory = installed.bindSharedToolRuntime(new InMemoryToolBroker());
  assert.equal(
    factory.runtimeOwnership?.({
      tenantId: scope.tenantId,
      version: f.entry.version,
    }),
    "ownedRuntime",
  );
  resolver = new StoreBackedAgentVersionRuntimeResolver({
    store,
    registry,
    digester,
    factory,
  });
  const lease = await resolver.acquire({
    tenantId: scope.tenantId,
    agentVersionId: f.entry.version.agentVersionId,
  });
  assert.ok(lease);
  assert.deepEqual(readInstalledPluginAgentRuntimeScope(lease.resource), scope);
  assert.equal(
    registry.peekResident({
      tenantId: scope.tenantId,
      agentVersionId: f.entry.version.agentVersionId,
    }),
    lease.resource,
  );
  assert.deepEqual(
    lease.resource.toolRuntime.definitions(),
    f.entry.version.tools,
  );
  lease.release();
  assert.equal(f.state.baseCloses, 0);
  resolver.close();
  await registry.close();
  assert.equal(f.state.baseCloses, 1);
});

test("factory snapshots host materializers and configuration before asynchronous package revalidation", async (t) => {
  const f = await factoryFixture(t);
  const entry = {
    ...f.entry,
    configuration: structuredClone(f.entry.configuration),
  };
  const factory = createInstalledPluginAgentVersionRuntimeFactory({
    defaultAgentVersionId: f.entry.base.version.agentVersionId,
    entries: [entry],
  });
  entry.createTransport = () => {
    throw new Error("mutated host callback");
  };
  entry.createBaseToolRuntime = () => {
    throw new Error("mutated base callback");
  };
  Reflect.set(entry.configuration, "revision", 99);
  const runtime = await factory.create({
    tenantId: scope.tenantId,
    version: f.entry.version,
  });
  assert.equal(runtime.extensions![0]!.configuration.revision, 1);
  assert.equal(f.state.transports, 1);
  assert.equal(f.state.baseTools, 1);
  await runtime.close?.();
});

for (const shared of [false, true])
  test(`captures immutable create input before real governance awaits through ${shared ? "shared binding" : "direct creation"}`, async (t) => {
    const f = await factoryFixture(t);
    let confirmations = 0;
    const input = {
      tenantId: scope.tenantId,
      version: structuredClone(f.entry.version),
      failedCreationCleanup: {
        confirmReleased() {
          confirmations++;
        },
      },
    };
    const original = structuredClone(input.version);
    const entry = {
      ...f.entry,
      async createGovernedContext() {
        input.tenantId = "tenant-moved";
        Reflect.set(input.version.model, "modelId", "mutated-model");
        input.version = f.entry.base.version;
        input.failedCreationCleanup.confirmReleased = () => {
          throw new Error("mutated cleanup callback");
        };
        return undefined;
      },
    };
    const installed = createInstalledPluginAgentVersionRuntimeFactory({
      defaultAgentVersionId: entry.base.version.agentVersionId,
      entries: [entry],
    });
    const factory = shared
      ? installed.bindSharedToolRuntime(new InMemoryToolBroker())
      : installed;
    const runtime = await factory.create(input);
    assert.deepEqual(readInstalledPluginAgentRuntimeScope(runtime), scope);
    assert.deepEqual(runtime.version, original);
    assert.equal(confirmations, 0);
    await runtime.close?.();
    assert.equal(f.state.baseCloses, 1);
    assert.equal(f.state.transportCloses, 1);
  });

test("a malformed proof on the actually constructed runtime closes its real resources before confirming clean failure", async (t) => {
  const f = await factoryFixture(t);
  const original = ConfiguredAgentVersionRuntimeFactory.prototype.create;
  t.mock.method(
    ConfiguredAgentVersionRuntimeFactory.prototype,
    "create",
    async function (
      this: ConfiguredAgentVersionRuntimeFactory,
      input: Parameters<typeof original>[0],
    ) {
      const actual = await original.call(this, input);
      Reflect.set(actual, "extensions", undefined);
      return actual;
    },
  );
  const factory = createInstalledPluginAgentVersionRuntimeFactory({
    defaultAgentVersionId: f.entry.base.version.agentVersionId,
    entries: [f.entry],
  });
  let confirmations = 0;
  let failure: unknown;
  await assert.rejects(
    factory.create({
      tenantId: scope.tenantId,
      version: f.entry.version,
      failedCreationCleanup: {
        confirmReleased() {
          confirmations++;
        },
      },
    }),
    (error: unknown) => {
      failure = error;
      return (
        error instanceof Error &&
        error.message === "installed_plugin_agent_runtime_proof_missing"
      );
    },
  );
  assert.equal(f.state.baseCloses, 1);
  assert.equal(f.state.transportCloses, 1);
  assert.equal(confirmations, 1);
  assert.equal(installedPluginAgentRuntimeFailureOwner(failure), null);
});

test("failed attestation cleanup retains the actual runtime failure owner and uncertain capacity", async (t) => {
  const f = await factoryFixture(t);
  f.state.baseCloseFails = true;
  const original = ConfiguredAgentVersionRuntimeFactory.prototype.create;
  t.mock.method(
    ConfiguredAgentVersionRuntimeFactory.prototype,
    "create",
    async function (
      this: ConfiguredAgentVersionRuntimeFactory,
      input: Parameters<typeof original>[0],
    ) {
      const actual = await original.call(this, input);
      Reflect.set(actual, "extensions", undefined);
      return actual;
    },
  );
  const factory = createInstalledPluginAgentVersionRuntimeFactory({
    defaultAgentVersionId: f.entry.base.version.agentVersionId,
    entries: [f.entry],
  });
  const capacity = new AgentRuntimeCapacity({ maximumOwners: 1 });
  let failure: unknown;
  await assert.rejects(
    createAdmittedAgentRuntime({
      capacity,
      factory,
      ownership: "ownedRuntime",
      tenantId: scope.tenantId,
      version: f.entry.version,
    }),
    (error: unknown) => {
      failure = error;
      return (
        error instanceof AggregateError &&
        error.message === "installed_plugin_agent_runtime_attestation_failed"
      );
    },
  );
  const owner = installedPluginAgentRuntimeFailureOwner(failure);
  assert.ok(owner);
  assert.ok(Object.isFrozen(owner));
  assert.equal(capacity.snapshot().uncertain, 1);
  assert.equal(capacity.snapshot().owners, 1);
  assert.equal(f.state.baseCloses, 1);
  assert.equal(f.state.transportCloses, 1);
  await assert.rejects(owner.close(), /agent_version_runtime_close_failed/);
  assert.equal(f.state.baseCloses, 1);
  assert.equal(capacity.snapshot().uncertain, 1);
  assert.equal(
    installedPluginAgentRuntimeFailureOwner(
      new AggregateError(
        [],
        "installed_plugin_agent_runtime_attestation_failed",
      ),
    ),
    null,
  );
  assert.equal(
    installedPluginAgentRuntimeFailureOwner({ ...(failure as object) }),
    null,
  );
  assert.equal(installedPluginAgentRuntimeFailureOwner(null), null);
});

test("an actual returned runtime whose close proof is missing never confirms clean attestation failure", async (t) => {
  const f = await factoryFixture(t);
  const original = ConfiguredAgentVersionRuntimeFactory.prototype.create;
  let physicalClose: (() => Promise<void>) | undefined;
  t.mock.method(
    ConfiguredAgentVersionRuntimeFactory.prototype,
    "create",
    async function (
      this: ConfiguredAgentVersionRuntimeFactory,
      input: Parameters<typeof original>[0],
    ) {
      const actual = await original.call(this, input);
      physicalClose = actual.close?.bind(actual);
      Reflect.set(actual, "extensions", undefined);
      Reflect.set(actual, "close", undefined);
      return actual;
    },
  );
  const factory = createInstalledPluginAgentVersionRuntimeFactory({
    defaultAgentVersionId: f.entry.base.version.agentVersionId,
    entries: [f.entry],
  });
  let confirmations = 0;
  let failure: unknown;
  try {
    await assert.rejects(
      factory.create({
        tenantId: scope.tenantId,
        version: f.entry.version,
        failedCreationCleanup: {
          confirmReleased() {
            confirmations++;
          },
        },
      }),
      (error: unknown) => {
        failure = error;
        return (
          error instanceof AggregateError &&
          error.message === "installed_plugin_agent_runtime_attestation_failed"
        );
      },
    );
    const owner = installedPluginAgentRuntimeFailureOwner(failure);
    assert.ok(owner);
    await assert.rejects(owner.close(), /cleanup_unavailable/);
    assert.equal(confirmations, 0);
    assert.equal(f.state.baseCloses, 0);
    assert.equal(f.state.transportCloses, 0);
  } finally {
    // Test-only out-of-band cleanup does not become a production owner proof.
    await physicalClose?.();
  }
});

test("failed attestation cannot confirm disposal of actual governed-context allocation without a close contract", async (t) => {
  const f = await factoryFixture(t);
  let governanceHandle: FileHandle | undefined;
  let allocations = 0;
  const entry = {
    ...f.entry,
    async createGovernedContext() {
      governanceHandle = await open(`${f.directory}/governance-resource`, "w+");
      await governanceHandle.writeFile("actual governed-context resource\n");
      allocations++;
      return undefined;
    },
  };
  const original = ConfiguredAgentVersionRuntimeFactory.prototype.create;
  t.mock.method(
    ConfiguredAgentVersionRuntimeFactory.prototype,
    "create",
    async function (
      this: ConfiguredAgentVersionRuntimeFactory,
      input: Parameters<typeof original>[0],
    ) {
      const actual = await original.call(this, input);
      Reflect.set(actual, "extensions", undefined);
      return actual;
    },
  );
  const factory = createInstalledPluginAgentVersionRuntimeFactory({
    defaultAgentVersionId: entry.base.version.agentVersionId,
    entries: [entry],
  });
  const capacity = new AgentRuntimeCapacity({ maximumOwners: 1 });
  let failure: unknown;
  try {
    await assert.rejects(
      createAdmittedAgentRuntime({
        capacity,
        factory,
        ownership: "ownedRuntime",
        tenantId: scope.tenantId,
        version: entry.version,
      }),
      (error: unknown) => {
        failure = error;
        return (
          error instanceof AggregateError &&
          error.message === "installed_plugin_agent_runtime_attestation_failed"
        );
      },
    );
    assert.equal(allocations, 1);
    assert.ok(governanceHandle);
    // The callback's real allocation remains open after runtime tools and transport closed.
    assert.ok((await governanceHandle.stat()).isFile());
    assert.equal(f.state.baseCloses, 1);
    assert.equal(f.state.transportCloses, 1);
    assert.equal(capacity.snapshot().owners, 1);
    assert.equal(capacity.snapshot().uncertain, 1);
    const owner = installedPluginAgentRuntimeFailureOwner(failure);
    assert.ok(owner);
    await assert.rejects(owner.close(), /cleanup_unproven/);
    assert.equal(capacity.snapshot().uncertain, 1);
  } finally {
    // Only the fixture knows this external allocation; it is not a runtime close proof.
    await governanceHandle?.close();
  }
});
