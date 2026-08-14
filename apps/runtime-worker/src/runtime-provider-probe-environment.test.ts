import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createNetServer, type Server } from "node:net";
import { inspect } from "node:util";
import test from "node:test";

import type { ModelProviderSettingsStore } from "@crewon/application";

import { DesktopProviderProbeEgressPolicy } from "./provider-probe-egress.ts";
import { startRuntimeProviderProbeServer } from "./provider-probe-server.ts";
import { RuntimeProviderProbeService } from "./provider-probe-service.ts";
import {
  parseRuntimeWorkerSecurityMode,
  resolveRuntimeProviderProbeEnvironment,
} from "./runtime-provider-probe-environment.ts";
import { runtimeNativeReadinessLines } from "./runtime-native-readiness.ts";

const TOKEN = "standalone-provider-probe-token-at-least-32-bytes";
const API_KEY = "standalone-provider-api-key-at-least-32-bytes";

test("production isolates its strict config from every standalone binding", () => {
  assert.equal(parseRuntimeWorkerSecurityMode("standalone"), "standalone");
  assert.equal(parseRuntimeWorkerSecurityMode("production"), "production");
  for (const value of ["", "team", " production", "PRODUCTION"]) {
    assert.throws(() => parseRuntimeWorkerSecurityMode(value));
  }
  assert.throws(
    () =>
      resolveRuntimeProviderProbeEnvironment(
        {},
        "production",
        new DesktopProviderProbeEgressPolicy(),
      ),
    /CREWON_RUNTIME_PROVIDER_PROBE_CONFIG_JSON_required/u,
  );
  for (const name of Object.keys(validEnvironment()).filter((name) =>
    name.startsWith("CREWON_PROVIDER_PROBE_"),
  )) {
    assert.throws(() =>
      resolveRuntimeProviderProbeEnvironment(
        { [name]: validEnvironment()[name] },
        "production",
        new DesktopProviderProbeEgressPolicy(),
      ),
    );
  }
  const production = resolveRuntimeProviderProbeEnvironment(
    productionEnvironment(),
    "production",
    new DesktopProviderProbeEgressPolicy(),
  );
  assert.equal(
    production?.runtimeBinding.runtimeBindingId,
    "runtime-generation-1",
  );
  assert.deepEqual(production?.productionCatalog, {
    tenantId: "tenant-1",
    expectedRevision: 0,
    runtimeBindingId: "runtime-generation-1",
    binding: {
      providerId: "gateway",
      displayName: "gateway",
      endpoint: "http://127.0.0.1:11434/v1",
      credentialKind: "environment",
      environmentVariable: "PROVIDER_API_KEY",
    },
  });
  assert.throws(
    () =>
      resolveRuntimeProviderProbeEnvironment(
        productionEnvironment(),
        "standalone",
        new DesktopProviderProbeEgressPolicy(),
      ),
    /CREWON_RUNTIME_PROVIDER_PROBE_CONFIG_JSON_forbidden/u,
  );
});

test("starts parsed private config and probes a real loopback Provider", async (t) => {
  const providerRequests: string[] = [];
  const provider = createServer((request, response) => {
    providerRequests.push(`${request.headers.authorization}:${request.url}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "model-a" }] }));
  });
  await listen(provider);
  t.after(() => close(provider));
  const providerAddress = provider.address();
  if (providerAddress === null || typeof providerAddress === "string") {
    throw new Error("provider_address_invalid");
  }
  const workerPort = await unusedLoopbackPort();
  const environment = {
    ...validEnvironment(),
    CREWON_PROVIDER_PROBE_PORT: String(workerPort),
    CREWON_PROVIDER_PROBE_ENDPOINT: `http://127.0.0.1:${providerAddress.port}/v1`,
  };
  const config = resolveRuntimeProviderProbeEnvironment(
    environment,
    "standalone",
    new DesktopProviderProbeEgressPolicy(),
  );
  assert.ok(config);
  const server = await startRuntimeProviderProbeServer({
    port: config.port,
    token: config.token,
    service: new RuntimeProviderProbeService({
      store: providerStore(config.runtimeBinding.endpoint),
      tenantId: "tenant-1",
      runtimeBinding: config.runtimeBinding,
      secrets: config.secrets,
      egressPolicy: config.egressPolicy,
    }),
  });
  t.after(() => server.close());

  const url = `${server.origin}/internal/v1/model-provider-probe`;
  const body = {
    tenantId: "tenant-1",
    expectedRevision: 3,
    expectedProviderId: "gateway",
    expectedRuntimeBindingId: "runtime-generation-1",
  };
  assert.equal(
    (await fetch(url, { method: "POST", body: JSON.stringify(body) })).status,
    401,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  const result = (await response.json()) as { latencyMs: number };
  assert.equal(Number.isSafeInteger(result.latencyMs), true);
  assert.deepEqual(
    { ...result, latencyMs: 0 },
    {
      providerId: "gateway",
      catalogRevision: 3,
      runtimeBindingId: "runtime-generation-1",
      status: "ok",
      models: [{ id: "model-a", displayName: null }],
      modelCount: 1,
      latencyMs: 0,
      retryable: false,
      retryAfterMs: null,
    },
  );
  assert.deepEqual(providerRequests, [`Bearer ${API_KEY}:/v1/models`]);
  const diagnostics = `${inspect(config)}\n${runtimeNativeReadinessLines({
    providerRuntimeBindingId: null,
    workspacePrivateOrigin: null,
    workspaceRuntimeBindingId: null,
  }).join("\n")}`;
  for (const secret of [
    TOKEN,
    API_KEY,
    config.runtimeBinding.runtimeBindingId,
  ]) {
    assert.equal(diagnostics.includes(secret), false);
  }
  assert.equal(inspect(config.runtimeBinding).includes("gateway"), false);
});

test("rejects catalog identities that PostgreSQL cannot commit", () => {
  for (const patch of [
    { providerId: "Gateway" },
    { expectedCatalogRevision: -1 },
    { expectedCatalogRevision: 1.5 },
    { expectedCatalogRevision: Number.MAX_SAFE_INTEGER },
  ]) {
    const environment = productionEnvironment();
    environment.CREWON_RUNTIME_PROVIDER_PROBE_CONFIG_JSON = JSON.stringify({
      ...JSON.parse(environment.CREWON_RUNTIME_PROVIDER_PROBE_CONFIG_JSON),
      ...patch,
    });
    assert.throws(
      () =>
        resolveRuntimeProviderProbeEnvironment(
          environment,
          "production",
          new DesktopProviderProbeEgressPolicy(),
        ),
      /CREWON_RUNTIME_PROVIDER_PROBE_CONFIG_JSON_invalid/u,
    );
  }
});

function validEnvironment(): Record<string, string> {
  return {
    CREWON_PROVIDER_PROBE_PORT: "3211",
    CREWON_PROVIDER_PROBE_TOKEN: TOKEN,
    CREWON_PROVIDER_PROBE_PROVIDER_ID: "gateway",
    CREWON_PROVIDER_PROBE_RUNTIME_BINDING_ID: "runtime-generation-1",
    CREWON_PROVIDER_PROBE_ENDPOINT: "http://127.0.0.1:11434/v1",
    CREWON_PROVIDER_PROBE_CREDENTIAL_ENVIRONMENT: "PROVIDER_API_KEY",
    PROVIDER_API_KEY: API_KEY,
  };
}

function productionEnvironment(): Record<string, string> {
  return {
    CREWON_RUNTIME_PROVIDER_PROBE_CONFIG_JSON: JSON.stringify({
      schemaVersion: "crewon.runtime-provider-probe.v1",
      port: 3211,
      tokenEnvironment: "PROVIDER_PROBE_TOKEN",
      tenantId: "tenant-1",
      expectedCatalogRevision: 0,
      providerId: "gateway",
      runtimeBindingId: "runtime-generation-1",
      endpoint: "http://127.0.0.1:11434/v1",
      credentialEnvironment: "PROVIDER_API_KEY",
    }),
    PROVIDER_PROBE_TOKEN: TOKEN,
    PROVIDER_API_KEY: API_KEY,
  };
}

function providerStore(endpoint: string): ModelProviderSettingsStore {
  return {
    loadModelProviderSettingsState: async () => ({
      catalog: {
        tenantId: "tenant-1",
        revision: 3,
        activeProviderId: "gateway",
        runtimeBindingId: "runtime-generation-1",
        bindings: [
          {
            providerId: "gateway",
            displayName: "Gateway",
            endpoint,
            credentialKind: "environment",
            environmentVariable: "PROVIDER_API_KEY",
          },
        ],
        updatedAt: "2026-08-12T00:00:00.000Z",
      },
      pending: null,
    }),
    prepareModelProviderSettings: async () => unexpected(),
    finalizeModelProviderSettings: async () => unexpected(),
    abortModelProviderSettings: async () => unexpected(),
    expireModelProviderSettings: async () => unexpected(),
  };
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("loopback_address_invalid");
  }
  await close(server);
  return address.port;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function unexpected(): never {
  throw new Error("unexpected_provider_store_mutation");
}
