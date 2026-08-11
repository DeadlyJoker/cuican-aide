import assert from "node:assert/strict";
import test from "node:test";

import { resolveStandaloneProviderProbeWorkers } from "./standalone-provider-probe-environment.ts";

const TOKEN = "standalone-provider-probe-token-at-least-32-bytes";

test("projects an all-or-none safe standalone Provider Probe route", async () => {
  assert.equal(
    resolveStandaloneProviderProbeWorkers({}, "standalone", "tenant-1"),
    undefined,
  );
  const registry = resolveStandaloneProviderProbeWorkers(
    {
      CREWON_PROVIDER_PROBE_WORKER_ORIGIN: "http://127.0.0.1:3211",
      CREWON_PROVIDER_PROBE_WORKER_TOKEN: TOKEN,
      CREWON_PROVIDER_PROBE_WORKER_TIMEOUT_MS: "12000",
    },
    "standalone",
    "tenant-1",
  );
  assert.notEqual(
    await registry?.resolve({ tenantId: "tenant-1", runtimeBindingId: "r1" }),
    null,
  );
  assert.equal(
    await registry?.resolve({ tenantId: "tenant-2", runtimeBindingId: "r1" }),
    null,
  );
});

test("rejects incomplete, unsafe, and production ambient routes", () => {
  const invalid = [
    { CREWON_PROVIDER_PROBE_WORKER_ORIGIN: "http://127.0.0.1:3211" },
    {
      CREWON_PROVIDER_PROBE_WORKER_ORIGIN: "http://provider.internal:3211",
      CREWON_PROVIDER_PROBE_WORKER_TOKEN: TOKEN,
    },
    {
      CREWON_PROVIDER_PROBE_WORKER_ORIGIN: "http://127.0.0.1:3211",
      CREWON_PROVIDER_PROBE_WORKER_TOKEN: TOKEN,
      CREWON_PROVIDER_PROBE_WORKER_TIMEOUT_MS: "999",
    },
  ];
  for (const environment of invalid) {
    assert.throws(() =>
      resolveStandaloneProviderProbeWorkers(environment, "standalone", "t"),
    );
  }
  assert.throws(() =>
    resolveStandaloneProviderProbeWorkers(
      { CREWON_PROVIDER_PROBE_WORKER_TOKEN: TOKEN },
      "production",
      "t",
    ),
  );
});
