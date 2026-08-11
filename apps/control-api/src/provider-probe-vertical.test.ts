import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryArtifactStore } from "@crewon/artifacts";
import type { ModelProviderProbeWorkerPort } from "@crewon/application";
import {
  DesktopProviderProbeEgressPolicy,
  RuntimeProviderProbeService,
  startRuntimeProviderProbeServer,
} from "@crewon/runtime-worker";
import { SqliteRunStore } from "@crewon/store";

import {
  HttpProviderProbeWorkerClient,
  ProviderProbeWorkerError,
  type TenantProviderProbeWorkerRegistry,
} from "./provider-probe-worker-client.ts";
import { createStandaloneControlApi } from "./standalone-composition.ts";

const PROBE_TOKEN = "provider-private-worker-token-32-bytes-minimum";
const ACTOR = {
  principalId: "standalone-principal",
  actorId: "standalone-actor",
  tenantId: "tenant-1",
  spaceId: "standalone-space",
} as const;

test("runs the private tenant-routed vertical through a real loopback Provider", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-provider-probe-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "control.sqlite");
  const providerRequests: Array<{
    authorization: string | undefined;
    url: string | undefined;
  }> = [];
  const provider = createServer((request, response) => {
    providerRequests.push({
      authorization: request.headers.authorization,
      url: request.url,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: [{ id: "model-a", display_name: "Model A" }, { id: "model-b" }],
        rawProviderMarker: "not-projected",
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        provider.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const providerAddress = provider.address();
  if (providerAddress === null || typeof providerAddress === "string") {
    throw new Error("provider_address_invalid");
  }
  const endpoint = `http://127.0.0.1:${providerAddress.port}/v1`;
  await seedProviderCatalog(databasePath, endpoint);

  const workerStore = new SqliteRunStore(databasePath);
  t.after(() => workerStore.close());
  const worker = await startRuntimeProviderProbeServer({
    port: 0,
    token: PROBE_TOKEN,
    service: probeService(workerStore, "tenant-1", endpoint),
  });
  t.after(() => worker.close());
  const wrongWorker = await startRuntimeProviderProbeServer({
    port: 0,
    token: PROBE_TOKEN,
    service: probeService(workerStore, "tenant-2", endpoint),
  });
  t.after(() => wrongWorker.close());

  let selected: ModelProviderProbeWorkerPort | null =
    new HttpProviderProbeWorkerClient({
      origin: worker.origin,
      token: PROBE_TOKEN,
    });
  const registry: TenantProviderProbeWorkerRegistry = {
    resolve: ({ tenantId, runtimeBindingId }) =>
      tenantId === ACTOR.tenantId &&
      runtimeBindingId === "provider-probe-test:generation-1"
        ? selected
        : null,
  };
  const runtime = createStandaloneControlApi({
    actor: ACTOR,
    defaultAgentVersionId: "unused-provider-probe-version",
    sessionToken: "provider-session-token-32-bytes-minimum",
    csrfToken: "provider-csrf-token-32-bytes-minimum",
    allowedOrigins: ["http://127.0.0.1:5175"],
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "provider-probe-artifact-key",
    providerProbeWorkers: registry,
    databasePath,
  });
  t.after(() => runtime.app.close());

  const result = await runtime.providerProbes.probe(
    ACTOR,
    new AbortController().signal,
  );
  assert.deepEqual(result.models, [
    { id: "model-a", displayName: "Model A" },
    { id: "model-b", displayName: null },
  ]);
  assert.equal(result.status, "ok");
  assert.deepEqual(providerRequests, [
    {
      authorization: "Bearer worker-memory-secret",
      url: "/v1/models",
    },
  ]);
  const projection = JSON.stringify(result);
  assert.equal(projection.includes("worker-memory-secret"), false);
  assert.equal(projection.includes("not-projected"), false);

  selected = new HttpProviderProbeWorkerClient({
    origin: wrongWorker.origin,
    token: PROBE_TOKEN,
  });
  assert.equal(
    (await runtime.providerProbes.probe(ACTOR, new AbortController().signal))
      .status,
    "bindingMismatch",
  );

  selected = {
    probe: async () => ({
      ...result,
      providerId: "wrong-provider",
    }),
  };
  await assert.rejects(
    runtime.providerProbes.probe(ACTOR, new AbortController().signal),
    (error) =>
      error instanceof ProviderProbeWorkerError &&
      error.code === "provider_probe_worker_response_mismatch",
  );

  selected = null;
  await assert.rejects(
    runtime.providerProbes.probe(ACTOR, new AbortController().signal),
    (error) =>
      error instanceof ProviderProbeWorkerError &&
      error.code === "provider_probe_worker_unavailable",
  );

  const probeStarted = deferred<void>();
  const secretReleased = deferred<void>();
  const cancelWorker = await startRuntimeProviderProbeServer({
    port: 0,
    token: PROBE_TOKEN,
    service: new RuntimeProviderProbeService(
      {
        store: workerStore,
        tenantId: "tenant-1",
        runtimeBinding: {
          runtimeBindingId: "provider-probe-test:generation-1",
          providerId: "gateway",
          endpoint,
          credentialKind: "keychain",
          environmentVariable: null,
        },
        secrets: {
          resolve: () => ({
            value: "worker-memory-secret",
            release: () => secretReleased.resolve(),
          }),
        },
        egressPolicy: new DesktopProviderProbeEgressPolicy(),
      },
      {
        createProbe: () => ({
          probe: (signal) => {
            probeStarted.resolve();
            return new Promise((_resolve, reject) => {
              const abort = () => reject(signal.reason);
              if (signal.aborted) abort();
              else signal.addEventListener("abort", abort, { once: true });
            });
          },
        }),
      },
    ),
  });
  t.after(() => cancelWorker.close());
  selected = new HttpProviderProbeWorkerClient({
    origin: cancelWorker.origin,
    token: PROBE_TOKEN,
  });
  const abort = new AbortController();
  const reason = new Error("caller_cancelled");
  const canceled = runtime.providerProbes.probe(ACTOR, abort.signal);
  await probeStarted.promise;
  abort.abort(reason);
  await assert.rejects(canceled, (error) => error === reason);
  await secretReleased.promise;
});

function probeService(
  store: SqliteRunStore,
  tenantId: string,
  endpoint: string,
): RuntimeProviderProbeService {
  return new RuntimeProviderProbeService({
    store,
    tenantId,
    runtimeBinding: {
      runtimeBindingId: "provider-probe-test:generation-1",
      providerId: "gateway",
      endpoint,
      credentialKind: "keychain",
      environmentVariable: null,
    },
    secrets: {
      resolve: () => ({ value: "worker-memory-secret", release: () => {} }),
    },
    egressPolicy: new DesktopProviderProbeEgressPolicy(),
  });
}

async function seedProviderCatalog(
  path: string,
  endpoint: string,
): Promise<void> {
  const store = new SqliteRunStore(path);
  try {
    const actor = {
      principalId: ACTOR.principalId,
      actorId: ACTOR.actorId,
      spaceId: ACTOR.spaceId,
    };
    await store.prepareModelProviderSettings({
      tenantId: ACTOR.tenantId,
      operationId: "provider-probe-operation",
      coordinatorBinding: "provider-probe-test:generation-1",
      expectedRevision: 0,
      activeProviderId: "gateway",
      bindings: [
        {
          providerId: "gateway",
          displayName: "Gateway",
          endpoint,
          credentialKind: "keychain",
          environmentVariable: null,
        },
      ],
      ttlMs: 300_000,
      idempotencyKey: "provider-probe-prepare",
      fingerprint: `sha256:${"a".repeat(64)}`,
      actor,
    });
    await store.finalizeModelProviderSettings({
      tenantId: ACTOR.tenantId,
      operationId: "provider-probe-operation",
      coordinatorBinding: "provider-probe-test:generation-1",
      idempotencyKey: "provider-probe-finalize",
      fingerprint: `sha256:${"b".repeat(64)}`,
      actor,
    });
  } finally {
    await store.close();
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
