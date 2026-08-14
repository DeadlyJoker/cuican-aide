import assert from "node:assert/strict";
import test from "node:test";

import { HttpProviderProbeWorkerClient } from "./provider-probe-worker-client.ts";
import { resolveProductionProviderProbeWorkers } from "./production-provider-probe-environment.ts";

const TOKEN = "production-provider-probe-token-at-least-32-bytes";

test("requires explicit authenticated Team Worker routes", () => {
  assert.throws(
    () => resolveProductionProviderProbeWorkers({}),
    /CREWON_PROVIDER_PROBE_TENANT_ROUTES_JSON_required/u,
  );
  assert.throws(
    () =>
      resolveProductionProviderProbeWorkers({
        CREWON_PROVIDER_PROBE_WORKER_ORIGIN: "http://127.0.0.1:3211",
        CREWON_PROVIDER_PROBE_TENANT_ROUTES_JSON: routes([]),
      }),
    /CREWON_PROVIDER_PROBE_WORKER_CONFIGURATION_forbidden/u,
  );
});

test("routes only the exact tenant and runtime generation", async () => {
  const registry = resolveProductionProviderProbeWorkers({
    CREWON_PROVIDER_PROBE_TENANT_ROUTES_JSON: routes([
      {
        tenantId: "tenant-1",
        runtimeBindingId: "runtime-1",
        origin: "https://worker-1.internal.example",
        token: TOKEN,
      },
      {
        tenantId: "tenant-1",
        runtimeBindingId: "runtime-2",
        origin: "https://worker-2.internal.example",
        token: `${TOKEN}-2`,
        timeoutMs: 5_000,
      },
    ]),
  });

  assert.ok(
    (await registry.resolve({
      tenantId: "tenant-1",
      runtimeBindingId: "runtime-1",
    })) instanceof HttpProviderProbeWorkerClient,
  );
  assert.ok(
    (await registry.resolve({
      tenantId: "tenant-1",
      runtimeBindingId: "runtime-2",
    })) instanceof HttpProviderProbeWorkerClient,
  );
  assert.equal(
    await registry.resolve({
      tenantId: "tenant-2",
      runtimeBindingId: "runtime-1",
    }),
    null,
  );
  assert.equal(
    await registry.resolve({
      tenantId: "tenant-1",
      runtimeBindingId: "runtime-3",
    }),
    null,
  );
});

test("rejects ambiguous or unauthenticated Team Worker routes", () => {
  for (const value of [
    [],
    [
      {
        tenantId: "tenant-1",
        runtimeBindingId: "runtime-1",
        origin: "http://worker.internal:3211",
        token: TOKEN,
      },
    ],
    [
      {
        tenantId: "tenant-1",
        runtimeBindingId: "runtime-1",
        origin: "https://worker.internal",
        token: "short",
      },
    ],
    [
      {
        tenantId: "tenant-1",
        runtimeBindingId: "runtime-1",
        origin: "https://worker.internal",
        token: TOKEN,
      },
      {
        tenantId: "tenant-1",
        runtimeBindingId: "runtime-1",
        origin: "https://worker-duplicate.internal",
        token: `${TOKEN}-duplicate`,
      },
    ],
  ]) {
    assert.throws(
      () =>
        resolveProductionProviderProbeWorkers({
          CREWON_PROVIDER_PROBE_TENANT_ROUTES_JSON: routes(value),
        }),
      /CREWON_PROVIDER_PROBE_TENANT_ROUTES_JSON_invalid/u,
    );
  }
});

function routes(value: unknown): string {
  return JSON.stringify(value);
}
