import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  AgentVersionError,
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import type { QueueClaimInput } from "@crewon/application";
import { createExtensionConfiguration } from "@crewon/domain";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";

import {
  compileRuntimeAgentVersion,
  createPostgresRuntimeWorker,
  createStandaloneRuntimeWorker,
  deriveRuntimeTeamTaskCapability,
  type RuntimeWorkerCompositionConfig,
} from "./standalone-composition.ts";
import { activateStandaloneRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";
import { DesktopProviderProbeEgressPolicy } from "./provider-probe-egress.ts";
import { resolveRuntimeExtensionEnvironment } from "./extensions/extension-process-environment.ts";
import { compileComfyAgentVersion } from "./extensions/comfyui-agent-version.ts";
import { bundledComfyRegistration } from "./extensions/comfyui-bundled-registration.ts";
import { extensionCompositionDeployments } from "./extensions/extension-runtime-composition.ts";

test("derives autonomous Team capability from the trusted Worker route", () => {
  const capability = deriveRuntimeTeamTaskCapability(
    {
      tenantId: "tenant-1",
      spaceId: "space-1",
      actorId: "actor-1",
      principalId: "principal-1",
    },
    {
      authorityId: "authority-1",
      runtimeGeneration: "runtime-1",
      agentVersionId: "agent-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
    },
  );
  assert.deepEqual(capability, {
    schemaVersion: "crewon.autonomous-task-capability.v0",
    tenantId: "tenant-1",
    spaceId: "space-1",
    actorId: "actor-1",
    principalId: "principal-1",
    authorityId: "authority-1",
    runtimeGeneration: "runtime-1",
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
    toolPermissionMode: "requestApproval",
  });
  assert.ok(Object.isFrozen(capability));
});

test("compiles the production Worker prefix into one immutable AgentVersion", () => {
  const version = compileRuntimeAgentVersion(runtimeConfig());

  assert.equal(version.agentVersionId, "agent-version-1");
  assert.equal(version.instructions, "stable instructions");
  assert.deepEqual(version.model, {
    adapterName: "fake-adapter",
    adapterVersion: "1",
    modelId: "fake-model",
    contextWindowTokens: 128_000,
    autoCompactAtTokens: 96_000,
  });
  assert.deepEqual(version.execution, {
    streamMaxRetries: 3,
    maxToolRounds: 12,
  });
  assert.ok(Object.isFrozen(version));
});

test("rejects same-ID production configuration drift before Store open", () => {
  const first = compileRuntimeAgentVersion(runtimeConfig());
  assert.throws(
    () =>
      compileRuntimeAgentVersion({
        ...runtimeConfig(),
        agentInstructions: "changed instructions",
        expectedAgentVersionDigest: first.contentDigest,
      }),
    (error) =>
      error instanceof AgentVersionError &&
      error.code === "agent_version_digest_mismatch",
  );
});

test("requires an externally activated bootstrap release before execution", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const config = runtimeConfig();
  const expected = compileRuntimeAgentVersion(config);
  await assert.rejects(
    createStandaloneRuntimeWorker({
      ...config,
      databasePath,
      scanIntervalMs: null,
    }),
    (error) =>
      error instanceof Error &&
      error.message === "runtime_release_bundle_missing",
  );
  await activateRelease(databasePath, config);
  const runtime = await createStandaloneRuntimeWorker({
    ...config,
    databasePath,
    scanIntervalMs: null,
  });
  assert.equal(runtime.workspacePrivateOrigin, null);
  await runtime.close();

  const store = new SqliteRunStore(databasePath);
  context.after(() => store.close());
  const asset = await store.loadAgentVersion({
    tenantId: config.runtimeTenantId,
    agentVersionId: expected.agentVersionId,
  });
  assert.equal(asset?.contentDigest, expected.contentDigest);
  const deployment = await store.loadAgentVersionDeployment({
    tenantId: config.runtimeTenantId,
    agentVersionId: expected.agentVersionId,
  });
  assert.ok(deployment !== null);
  assert.match(deployment.deployedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.deepEqual(
    { ...deployment, deployedAt: "<time>" },
    {
      schemaVersion: "crewon.agent-version-deployment.v0",
      tenantId: config.runtimeTenantId,
      agentVersionId: expected.agentVersionId,
      contentDigest: expected.contentDigest,
      materializationDigest: `sha256:${createHash("sha256")
        .update(
          JSON.stringify({
            schemaVersion: "crewon.static-agent-materialization.v0",
            authorityId: config.route.authorityId,
            workspaceBindingId: config.route.workspaceBindingId,
            adapterName: config.transport.adapterName,
            adapterVersion: config.transport.adapterVersion,
            modelId: config.transport.modelId,
          }),
        )
        .digest("hex")}`,
      authorityId: config.route.authorityId,
      workspaceBindingId: config.route.workspaceBindingId,
      deployedAt: "<time>",
    },
  );
});

test("does not install the experimental Team journal unless explicitly configured", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const config = runtimeConfig();
  await activateRelease(databasePath, config);
  const runtime = await createStandaloneRuntimeWorker({
    ...config,
    databasePath,
    scanIntervalMs: null,
  });
  await runtime.close();
  const store = new SqliteRunStore(databasePath);
  context.after(() => store.close());
  const journal = await store.experimentalTeamTaskJournalStore();
  await assert.rejects(
    journal.read({
      tenantId: config.runtimeTenantId,
      spaceId: "space-1",
      taskId: "team-task-default-off",
    }),
    /team_journal_schema_unavailable/u,
  );
});

test("explicit Team scheduler migration is owned by Runtime Worker lifecycle", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const config = runtimeConfig();
  await activateRelease(databasePath, config);
  const runtime = await createStandaloneRuntimeWorker({
    ...config,
    databasePath,
    scanIntervalMs: null,
    teamTaskScheduler: {
      scope: { tenantId: config.runtimeTenantId, spaceId: "space-1" },
      scanIntervalMs: null,
      execute: async () => {},
    },
  });
  assert.ok(runtime.teamTaskScheduler !== null);
  runtime.start();
  runtime.teamTaskScheduler!.notify();
  await runtime.close();
  const store = new SqliteRunStore(databasePath);
  context.after(() => store.close());
  const journal = await store.experimentalTeamTaskJournalStore();
  assert.equal(
    await journal.read({
      tenantId: config.runtimeTenantId,
      spaceId: "space-1",
      taskId: "team-task-explicit-on",
    }),
    null,
  );
});

test("rejects an ambiguous Team executor before migrating its journal", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const config = runtimeConfig();
  await activateRelease(databasePath, config);
  await assert.rejects(
    createStandaloneRuntimeWorker({
      ...config,
      databasePath,
      scanIntervalMs: null,
      teamTaskScheduler: {
        scope: { tenantId: config.runtimeTenantId, spaceId: "space-1" },
        scanIntervalMs: null,
      },
    }),
    /team_task_executor_configuration_invalid/u,
  );
  const store = new SqliteRunStore(databasePath);
  context.after(() => store.close());
  const journal = await store.experimentalTeamTaskJournalStore();
  await assert.rejects(
    journal.read({
      tenantId: config.runtimeTenantId,
      spaceId: "space-1",
      taskId: "team-task-ambiguous-executor",
    }),
    /team_journal_schema_unavailable/u,
  );
});

test("metadata-only extension host migrates its scheduling records before the first claim", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const config = runtimeConfig();
  await activateRelease(databasePath, config);
  const extensions = resolveRuntimeExtensionEnvironment(
    {
      CREWON_EXTENSIONS_ENABLED: "1",
      CREWON_EXTENSION_HOST_PORT: "0",
      CREWON_EXTENSION_HOST_TOKEN: "metadata-host-private-token-32-bytes",
      CREWON_PRINCIPAL_ID: "principal",
      CREWON_ACTOR_ID: "actor",
      CREWON_TENANT_ID: config.runtimeTenantId,
      CREWON_SPACE_ID: "space",
    },
    "standalone",
  );
  assert.ok(extensions);
  const runtime = await createStandaloneRuntimeWorker({
    ...config,
    databasePath,
    scanIntervalMs: null,
    extensionHost: extensions.host,
  });
  try {
    assert.match(runtime.extensionHostOrigin!, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.deepEqual(await runtime.worker.wake(), { kind: "idle" });
  } finally {
    await runtime.close();
  }
});

test("historical Worker mode requires explicit composed extensions before opening storage", async (context) => {
  for (const mode of ["current", "historical", "invalid"] as const) {
    const databasePath = temporaryDatabasePath(context);
    const config = runtimeConfig();
    let closed = 0;
    await assert.rejects(
      createStandaloneRuntimeWorker({
        ...config,
        transport: {
          ...config.transport,
          close: async () => {
            closed += 1;
          },
        },
        databasePath,
        extensionExecutionMode: mode as "historical",
      }),
      /extension_execution_mode_(?:without_host|invalid)|extension_historical_runtime_required/u,
    );
    assert.equal(existsSync(databasePath), false);
    assert.equal(closed, 1);
  }
});

test("Postgres composition keeps a disabled plugin snapshot while its mocked open is pending", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const initial = runtimeConfig();
  await activateRelease(databasePath, initial);
  const { store, resume } = pausePostgresOpenWithSqlite(context, databasePath);
  const requests = observeClaims(context, store);
  context.mock.method(store, "extensionStore", () =>
    assert.fail("disabled composition must not access plugin tables"),
  );
  const config = {
    ...initial,
    route: { ...initial.route },
    connectionString: "mocked-postgres-open",
    scanIntervalMs: null,
  };
  const pending = createPostgresRuntimeWorker(config);
  Object.assign(config, {
    runtimeTenantId: "foreign-tenant",
    extensionHost: metadataHost(initial.runtimeTenantId).host,
    extensionExecutionMode: "historical",
  });
  config.route.agentVersionId = "changed-default-agent";
  resume();
  const runtime = await pending;
  context.after(() => runtime.close());
  assert.equal(runtime.extensionHostOrigin, null);
  assert.equal(
    runtime.agentVersion.agentVersionId,
    initial.route.agentVersionId,
  );
  assert.deepEqual(await runtime.worker.wake(), { kind: "idle" });
  assert.equal(requests.length, 1);
  assert.equal(Object.hasOwn(requests[0]!, "executionScope"), false);
});

test("Postgres composition snapshots metadata host values before its mocked open yields", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const initial = runtimeConfig();
  await activateRelease(databasePath, initial);
  const { store, resume } = pausePostgresOpenWithSqlite(context, databasePath);
  const requests = observeClaims(context, store);
  const { host, actor } = metadataHost(initial.runtimeTenantId);
  const extensionHost = { ...host };
  const config = {
    ...initial,
    connectionString: "mocked-postgres-open",
    scanIntervalMs: null,
    extensionHost,
  };
  const pending = createPostgresRuntimeWorker(config);
  Object.assign(extensionHost, {
    port: -1,
    token: "changed-token",
    deadlineMs: 0,
    authorization: { authorize: async () => ({ outcome: "deny" }) },
    resolveActor: async () => null,
  });
  resume();
  const runtime = await pending;
  context.after(() => runtime.close());
  const response = await extensionCatalog(
    runtime.extensionHostOrigin!,
    host.token,
    actor,
  );
  assert.equal(response.status, 200);
  assert.equal(
    (
      await extensionCatalog(
        runtime.extensionHostOrigin!,
        extensionHost.token,
        actor,
      )
    ).status,
    401,
  );
  assert.deepEqual(await runtime.worker.wake(), { kind: "idle" });
  assert.equal(requests[0]?.executionScope?.tenantId, initial.runtimeTenantId);
  assert.equal(requests[0]?.executionScope?.unboundRuns, "include");
  assert.deepEqual(requests[0]?.executionScope?.extensionTargets, []);
});

test("Postgres composition snapshots historical runtime paths, environment and private host before mocked open", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const initial = {
    ...runtimeConfig(),
    transport: { ...fakeTransport(), adapterName: "direct-responses" },
  };
  const plugin = historicalPluginFixture(databasePath, initial);
  await activateRelease(databasePath, {
    ...initial,
    additionalAgentVersions: [plugin.version],
    agentVersionDeployments: extensionCompositionDeployments({
      config: plugin.extensionRuntime,
      tenantId: initial.runtimeTenantId,
      defaultAgentVersionId: initial.route.agentVersionId,
    }),
  });
  const { store, resume } = pausePostgresOpenWithSqlite(context, databasePath);
  const requests = observeClaims(context, store);
  const config = {
    ...initial,
    connectionString: "mocked-postgres-open",
    scanIntervalMs: null,
    extensionRuntime: plugin.extensionRuntime,
    additionalAgentVersions: [plugin.version],
    extensionExecutionMode: "historical" as const,
  };
  const pending = createPostgresRuntimeWorker(config);
  plugin.extensionRuntime.runtimeBindingsPath = join(
    dirname(databasePath),
    "missing-bindings.json",
  );
  plugin.extensionRuntime.additionalRuntimeBindingsPaths.push(
    "missing-extra-bindings.json",
  );
  delete plugin.extensionRuntime.environment.TEST_PLUGIN_PROVIDER_KEY;
  Object.assign(plugin.extensionRuntime.privateHost, {
    port: -1,
    token: "changed",
    deadlineMs: 0,
  });
  Object.assign(plugin.extensionRuntime, {
    authorization: { authorize: async () => ({ outcome: "deny" }) },
    resolveActor: async () => null,
  });
  resume();
  const runtime = await pending;
  context.after(() => runtime.close());
  assert.equal(
    (
      await extensionCatalog(
        runtime.extensionHostOrigin!,
        plugin.token,
        plugin.actor,
      )
    ).status,
    200,
  );
  assert.deepEqual(await runtime.worker.wake(), { kind: "idle" });
  const deployment = await store.loadAgentVersionDeployment({
    tenantId: initial.runtimeTenantId,
    agentVersionId: plugin.version.agentVersionId,
  });
  assert.ok(deployment);
  assert.deepEqual(requests[0]?.executionScope, {
    tenantId: initial.runtimeTenantId,
    extensionImplementationDigest: plugin.registration.implementationDigest,
    unboundRuns: "exclude",
    extensionTargets: [
      {
        executionAuthority: "crewonKernel",
        agentVersionId: plugin.version.agentVersionId,
        agentVersionContentDigest: plugin.version.contentDigest,
        materializationDigest: deployment.materializationDigest,
        authorityId: "historical-plugin-authority",
        runtimeGeneration: plugin.version.runtimeGeneration,
        policySnapshotId: plugin.version.policySnapshotId,
        workspaceBindingId: null,
      },
    ],
  });
});

test("refuses bootstrap materialization drift for an existing Deployment", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const config = runtimeConfig();
  await activateRelease(databasePath, config);
  const first = await createStandaloneRuntimeWorker({
    ...config,
    databasePath,
    scanIntervalMs: null,
  });
  await first.close();

  await assert.rejects(
    createStandaloneRuntimeWorker({
      ...config,
      route: { ...config.route, authorityId: "authority-drift" },
      databasePath,
      scanIntervalMs: null,
    }),
    (error) =>
      error instanceof Error &&
      error.message === "runtime_release_bundle_missing",
  );
});

test("refuses bootstrap startup when the durable ID already has different content", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const config = runtimeConfig();
  const conflict = compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId: config.route.agentVersionId,
      runtimeGeneration: config.route.runtimeGeneration,
      policySnapshotId: config.route.policySnapshotId,
      instructions: "conflicting durable definition",
      model: {
        adapterName: config.transport.adapterName,
        adapterVersion: config.transport.adapterVersion,
        modelId: config.transport.modelId,
        contextWindowTokens: 128_000,
        autoCompactAtTokens: 96_000,
      },
      execution: { streamMaxRetries: 3, maxToolRounds: 12 },
      resources: {
        workspaceRequired: false,
        governedContextDigest: null,
      },
      tools: [],
    },
    {
      sha256: (value) =>
        `sha256:${createHash("sha256").update(value).digest("hex")}`,
    },
  );
  const store = new SqliteRunStore(databasePath);
  await store.registerAgentVersion(
    createAgentVersionAsset({
      tenantId: config.runtimeTenantId,
      version: conflict,
      createdAt: "2026-08-09T00:00:00Z",
    }),
  );
  await store.close();

  await assert.rejects(
    activateRelease(databasePath, config),
    (error) =>
      error instanceof Error && error.message === "agent_version_id_conflict",
  );
});

test("starts and closes the optional private Provider probe server", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const config = runtimeConfig();
  await activateRelease(databasePath, config);
  const runtime = await createStandaloneRuntimeWorker({
    ...config,
    databasePath,
    scanIntervalMs: null,
    providerProbe: probeConfig(0),
  });
  assert.match(
    runtime.providerProbeOrigin ?? "",
    /^http:\/\/127\.0\.0\.1:\d+$/u,
  );
  await runtime.close();
});

test("starts the optional loopback Workspace server and closes its Gateway client", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const config = workspaceRuntimeConfig();
  await activateRelease(databasePath, config);
  let gatewayCloses = 0;
  const runtime = await createStandaloneRuntimeWorker({
    ...config,
    databasePath,
    scanIntervalMs: null,
    workspacePrivate: workspaceConfig(0, () => {
      gatewayCloses += 1;
    }),
  });
  assert.match(
    runtime.workspacePrivateOrigin ?? "",
    /^http:\/\/127\.0\.0\.1:\d+$/u,
  );
  await runtime.close();
  assert.equal(gatewayCloses, 1);
});

test("closes Workspace resources when the private loopback port is occupied", async (context) => {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        blocker.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = blocker.address();
  assert.ok(address !== null && typeof address !== "string");
  const databasePath = temporaryDatabasePath(context);
  const config = workspaceRuntimeConfig();
  await activateRelease(databasePath, config);
  let gatewayCloses = 0;
  await assert.rejects(
    createStandaloneRuntimeWorker({
      ...config,
      databasePath,
      scanIntervalMs: null,
      workspacePrivate: workspaceConfig(address.port, () => {
        gatewayCloses += 1;
      }),
    }),
    (error) =>
      error instanceof Error && "code" in error && error.code === "EADDRINUSE",
  );
  assert.equal(gatewayCloses, 1);
  const reopened = new SqliteRunStore(databasePath);
  await reopened.close();
});

test("closes packaged Workspace Gateway and Store on static deployment mismatch", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const config = runtimeConfig();
  await activateRelease(databasePath, config);
  let gatewayCloses = 0;
  await assert.rejects(
    createStandaloneRuntimeWorker({
      ...config,
      databasePath,
      scanIntervalMs: null,
      workspacePrivate: workspaceConfig(0, () => {
        gatewayCloses += 1;
      }),
    }),
    (error) =>
      error instanceof Error &&
      error.message === "runtime_workspace_deployment_mismatch",
  );
  assert.equal(gatewayCloses, 1);
  const reopened = new SqliteRunStore(databasePath);
  await reopened.close();
});

test("closes Worker resources when the private probe port is occupied", async (context) => {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        blocker.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = blocker.address();
  if (address === null || typeof address === "string") {
    throw new Error("provider_probe_test_address_invalid");
  }
  const databasePath = temporaryDatabasePath(context);
  const config = runtimeConfig();
  await activateRelease(databasePath, config);
  await assert.rejects(
    createStandaloneRuntimeWorker({
      ...config,
      databasePath,
      scanIntervalMs: null,
      providerProbe: probeConfig(address.port),
    }),
    (error) =>
      error instanceof Error && "code" in error && error.code === "EADDRINUSE",
  );
  const reopened = new SqliteRunStore(databasePath);
  await reopened.close();
});

function pausePostgresOpenWithSqlite(
  context: TestContext,
  databasePath: string,
) {
  // Exercise the Pg composition await boundary, with a real SQLite store behind it.
  const store = new SqliteRunStore(databasePath);
  context.after(() => store.close());
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  context.mock.method(PostgresDomainStore, "open", async () => {
    await paused;
    return store;
  });
  return { store, resume };
}

function observeClaims(context: TestContext, store: SqliteRunStore) {
  const requests: QueueClaimInput[] = [];
  const claim = store.claimNextWorkItem.bind(store);
  context.mock.method(store, "claimNextWorkItem", (input: QueueClaimInput) => {
    requests.push(input);
    return claim(input);
  });
  return requests;
}

function metadataHost(tenantId: string) {
  const parsed = resolveRuntimeExtensionEnvironment(
    {
      CREWON_EXTENSIONS_ENABLED: "1",
      CREWON_EXTENSION_HOST_PORT: "0",
      CREWON_EXTENSION_HOST_TOKEN:
        "composition-snapshot-private-token-32-bytes",
      CREWON_PRINCIPAL_ID: "principal",
      CREWON_ACTOR_ID: "actor",
      CREWON_TENANT_ID: tenantId,
      CREWON_SPACE_ID: "space",
    },
    "standalone",
  );
  assert.ok(parsed);
  return parsed;
}

function extensionCatalog(
  origin: string,
  token: string,
  actor: ReturnType<typeof metadataHost>["actor"],
) {
  return fetch(`${origin}/private/v0/extensions`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocol: "crewon.extension-host-request.v0",
      operation: "catalog",
      actor,
    }),
  });
}

function historicalPluginFixture(
  databasePath: string,
  base: RuntimeWorkerCompositionConfig,
) {
  const digester = {
    sha256: (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`,
  };
  const version = compileComfyAgentVersion({
    base: {
      executionAuthority: "crewonKernel",
      version: compileRuntimeAgentVersion(base),
    },
    agentVersionId: "historical-plugin-version",
    runtimeGeneration: base.route.runtimeGeneration,
    policySnapshotId: "historical-plugin-policy",
    digester,
  });
  const registration = bundledComfyRegistration();
  const { host, actor } = metadataHost(base.runtimeTenantId);
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: base.runtimeTenantId,
      spaceId: actor.spaceId,
      pluginId: registration.manifest.pluginId,
      pluginVersion: registration.manifest.version,
      revision: 1,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      parameters: { baseUrl: "https://comfy.example/" },
      credentialBindings: [],
      createdByActorId: actor.actorId,
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    digester,
  );
  const root = dirname(databasePath);
  const extensionConfigPath = join(root, "historical-plugin.json");
  writeFileSync(
    extensionConfigPath,
    JSON.stringify({
      schemaVersion: "crewon.extension-runtime-config.v0",
      configuration,
      approvalRequirement: "none",
    }),
  );
  const runtimeBindingsPath = join(root, "historical-bindings.json");
  writeFileSync(
    runtimeBindingsPath,
    JSON.stringify({
      schemaVersion: "crewon.agent-version-runtime-bindings.v0",
      bindings: [
        {
          tenantId: base.runtimeTenantId,
          agentVersionId: version.agentVersionId,
          contentDigest: version.contentDigest,
          authorityId: "historical-plugin-authority",
          workspaceBindingId: null,
          provider: {
            kind: "directResponses",
            endpoint: "https://provider.example/v1/responses",
            apiKeyEnvironment: "TEST_PLUGIN_PROVIDER_KEY",
            storeResponses: false,
            requestProfile: "standard",
            idleTimeoutMs: 60_000,
            sequencePolicy: "required",
          },
          mcpStdioConfigPath: null,
          deviceToolConfigPath: null,
          remoteMcpConfigPath: null,
          extensionConfigPath,
        },
      ],
    }),
  );
  return {
    version,
    registration,
    actor,
    token: host.token,
    extensionRuntime: {
      runtimeBindingsPath,
      additionalRuntimeBindingsPaths: [] as string[],
      environment: {
        TEST_PLUGIN_PROVIDER_KEY: "operator-fixture-key",
      } as Record<string, string | undefined>,
      privateHost: { port: host.port, token: host.token, deadlineMs: 10_000 },
      authorization: host.authorization,
      resolveActor: host.resolveActor,
    },
  };
}

function runtimeConfig(): RuntimeWorkerCompositionConfig {
  return {
    runtimeTenantId: "tenant-1",
    route: {
      authorityId: "authority-1",
      runtimeGeneration: "ts-v0",
      agentVersionId: "agent-version-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: null,
    },
    transport: fakeTransport(),
    agentInstructions: "stable instructions",
    streamMaxRetries: 3,
    maxToolRounds: 12,
    autoCompactAtTokens: 96_000,
    modelContextWindowTokens: 128_000,
  };
}

function workspaceRuntimeConfig(): RuntimeWorkerCompositionConfig {
  return {
    ...runtimeConfig(),
    route: {
      ...runtimeConfig().route,
      runtimeGeneration: "runtime-binding-1",
      workspaceBindingId: "workspace-1",
    },
  };
}

function fakeTransport(): ModelTransportPort {
  return {
    adapterName: "fake-adapter",
    adapterVersion: "1",
    modelId: "fake-model",
    async *stream() {
      yield { type: "completed", checkpoint: null };
    },
  };
}

function probeConfig(port: number) {
  return {
    port,
    token: "runtime-worker-private-probe-token-32-bytes",
    runtimeBinding: {
      runtimeBindingId: "desktop-supervisor:generation-7",
      providerId: "gateway",
      endpoint: "http://127.0.0.1:9/v1",
      credentialKind: "none" as const,
      environmentVariable: null,
    },
    secrets: { resolve: () => null },
    egressPolicy: new DesktopProviderProbeEgressPolicy(),
  };
}

function workspaceConfig(port: number, closed: () => void) {
  return {
    port,
    token: "runtime-worker-private-workspace-token-32-bytes",
    authority: {
      tenantId: "tenant-1",
      spaceId: "space-1",
      workspaceBindingId: "workspace-1",
      incarnationId: "incarnation-1",
      deviceBindingId: "device-binding-1",
      deviceId: "device-1",
      runtimeBindingId: "runtime-binding-1",
      policySnapshotId: "policy-1",
    },
    ids: { nextExecutionId: () => "workspace-execution-1" },
    signer: { sign: async () => assert.fail("sign not expected") },
    gateway: {
      execute: async () => assert.fail("execute not expected"),
      reconcile: async () => assert.fail("reconcile not expected"),
      cancel: async () => assert.fail("cancel not expected"),
      close: async () => closed(),
    },
  };
}

async function activateRelease(
  databasePath: string,
  config: RuntimeWorkerCompositionConfig,
): Promise<void> {
  await activateStandaloneRuntimeAgentVersionRelease({
    ...config,
    databasePath,
    actor: {
      principalId: "release-principal",
      actorId: "release-actor",
      tenantId: config.runtimeTenantId,
      spaceId: "release-space",
    },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-09T00:00:00Z" },
    activationId: "activation-standalone-test",
  });
}

function temporaryDatabasePath(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "crewon-agent-version-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "control.sqlite");
}
