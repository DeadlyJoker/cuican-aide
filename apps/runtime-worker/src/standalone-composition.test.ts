import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  AgentVersionError,
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import { SqliteRunStore } from "@crewon/store";

import {
  compileRuntimeAgentVersion,
  createStandaloneRuntimeWorker,
  type RuntimeWorkerCompositionConfig,
} from "./standalone-composition.ts";
import { activateStandaloneRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";
import { DesktopProviderProbeEgressPolicy } from "./provider-probe-egress.ts";

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
  assert.match(runtime.providerProbeOrigin ?? "", /^http:\/\/127\.0\.0\.1:\d+$/u);
  await runtime.close();
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
    (error) => error instanceof Error && "code" in error && error.code === "EADDRINUSE",
  );
  const reopened = new SqliteRunStore(databasePath);
  await reopened.close();
});

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
