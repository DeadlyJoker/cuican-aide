import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";

import type { ModelTransportPort } from "@crewon/agent-kernel";
import { InMemoryRunStore, PostgresDomainStore } from "@crewon/store";
import { Pool } from "pg";

import { activatePostgresRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";
import { DesktopProviderProbeEgressPolicy } from "./provider-probe-egress.ts";
import {
  assertProductionProviderCatalogRoute,
  bootstrapProductionProviderCatalog,
  type ProductionProviderCatalogAuthority,
} from "./production-provider-catalog-bootstrap.ts";
import { createPostgresRuntimeWorker } from "./standalone-composition.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;

test("bootstraps and replays one exact non-secret Provider catalog", async () => {
  const store = new InMemoryRunStore();
  const [first, second] = await Promise.all([
    bootstrapProductionProviderCatalog(store, authority()),
    bootstrapProductionProviderCatalog(store, authority()),
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(
    await store.loadModelProviderSettingsState({ tenantId: "tenant-1" }),
    {
      catalog: first,
      pending: null,
    },
  );
  assert.equal(JSON.stringify(first).includes("provider-secret-value"), false);

  const updated = await bootstrapProductionProviderCatalog(store, {
    ...authority(),
    expectedRevision: 1,
    runtimeBindingId: "runtime-2",
    binding: {
      ...authority().binding,
      endpoint: "https://provider-v2.example/v1",
    },
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.runtimeBindingId, "runtime-2");
});

test("fails closed on a pending mutation, stale CAS, or route mismatch", async () => {
  const pendingStore = new InMemoryRunStore();
  await pendingStore.prepareModelProviderSettings({
    tenantId: "tenant-1",
    operationId: "competing-operation",
    coordinatorBinding: "runtime-competing",
    expectedRevision: 0,
    activeProviderId: "competing",
    bindings: [
      {
        providerId: "competing",
        displayName: "competing",
        endpoint: "https://competing.example/v1",
        credentialKind: "environment",
        environmentVariable: "COMPETING_API_KEY",
      },
    ],
    ttlMs: 300_000,
    idempotencyKey: "competing-prepare",
    fingerprint: `sha256:${"a".repeat(64)}`,
    actor: {
      principalId: "admin",
      actorId: "admin",
      spaceId: "admin",
    },
  });
  await assert.rejects(
    bootstrapProductionProviderCatalog(pendingStore, authority()),
    /runtime_provider_catalog_pending_conflict/u,
  );

  const revisionStore = new InMemoryRunStore();
  await bootstrapProductionProviderCatalog(revisionStore, authority());
  await assert.rejects(
    bootstrapProductionProviderCatalog(revisionStore, {
      ...authority(),
      runtimeBindingId: "runtime-2",
    }),
    /runtime_provider_catalog_revision_mismatch/u,
  );
  assert.throws(
    () =>
      assertProductionProviderCatalogRoute(authority(), {
        tenantId: "tenant-other",
        runtimeBindingId: "runtime-1",
      }),
    /runtime_provider_catalog_route_mismatch/u,
  );
});

test(
  "PostgreSQL composition bootstraps before opening its Provider listener",
  { skip: connectionString === undefined },
  async (context) => {
    const fixture = await postgresFixture(context);
    const config = runtimeConfig();
    await activatePostgresRuntimeAgentVersionRelease({
      ...config,
      ...fixture.options,
      actor: {
        principalId: "release-principal",
        actorId: "release-actor",
        tenantId: "tenant-1",
        spaceId: "release-space",
      },
      authorization: { authorize: async () => ({ outcome: "allow" }) },
      clock: { now: () => "2026-08-14T00:00:00.000Z" },
      activationId: "provider-bootstrap-release",
    });
    const runtime = await createPostgresRuntimeWorker({
      ...config,
      ...fixture.options,
      scanIntervalMs: null,
      productionProviderCatalog: authority(),
      providerProbe: {
        port: 0,
        token: "production-provider-probe-token-at-least-32-bytes",
        runtimeBinding: {
          runtimeBindingId: "runtime-1",
          providerId: "gateway",
          endpoint: "https://provider.example/v1",
          credentialKind: "environment",
          environmentVariable: "PRODUCTION_PROVIDER_API_KEY",
        },
        secrets: { resolve: () => null },
        egressPolicy: new DesktopProviderProbeEgressPolicy(),
      },
    });
    const verifier = await PostgresDomainStore.open(fixture.options);
    try {
      assert.match(
        runtime.providerProbeOrigin ?? "",
        /^http:\/\/127\.0\.0\.1:\d+$/u,
      );
      const state = await verifier.loadModelProviderSettingsState({
        tenantId: "tenant-1",
      });
      assert.equal(state.catalog?.revision, 1);
      assert.equal(state.pending, null);
      assert.equal(
        JSON.stringify(state).includes("provider-secret-value"),
        false,
      );
    } finally {
      await Promise.all([runtime.close(), verifier.close()]);
    }
  },
);

function authority(): ProductionProviderCatalogAuthority {
  return {
    tenantId: "tenant-1",
    expectedRevision: 0,
    runtimeBindingId: "runtime-1",
    binding: {
      providerId: "gateway",
      displayName: "gateway",
      endpoint: "https://provider.example/v1",
      credentialKind: "environment",
      environmentVariable: "PRODUCTION_PROVIDER_API_KEY",
    },
  };
}

function runtimeConfig() {
  return {
    runtimeTenantId: "tenant-1",
    route: {
      authorityId: "authority-1",
      runtimeGeneration: "runtime-1",
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
      yield { type: "completed" as const, checkpoint: null };
    },
  };
}

async function postgresFixture(context: TestContext) {
  const schema = `provider_bootstrap_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  context.after(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  return {
    options: { connectionString: connectionString!, schema },
  };
}
