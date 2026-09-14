import assert from "node:assert/strict";
import test from "node:test";

import {
  createControlDevEnvironment,
  defaultControlDataDirectory,
  developmentAgentVersionId,
  developmentRuntimeWorkerCount,
  developmentRuntimeWorkerEnvironment,
  responsesEndpoint,
} from "./crewon-control-web-dev.mjs";

test("uses the existing desktop development data directory on macOS", () => {
  assert.equal(
    defaultControlDataDirectory("darwin", "/Users/test"),
    "/Users/test/Library/Application Support/ai.crewon.desktop.dev/control-runtime-v0",
  );
});

test("builds a provider Responses endpoint without discarding the base path", () => {
  assert.equal(
    responsesEndpoint("https://provider.example/v1"),
    "https://provider.example/v1/responses",
  );
  assert.throws(
    () => responsesEndpoint("http://provider.example/v1"),
    /HTTPS or loopback HTTP/u,
  );
});

test("creates a workspace-free TypeScript runtime environment", () => {
  const environment = createControlDevEnvironment({
    agentVersionId: "agent-version-1",
    apiKey: "a".repeat(32),
    baseEnvironment: {
      CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: "/private/bindings.json",
      CREWON_CONTROL_DATABASE_URL: "postgres://forbidden",
      CREWON_WORKSPACE_BINDING_ID: "workspace-1",
    },
    controlPort: 3210,
    csrfToken: "c".repeat(64),
    dataDirectory: "/runtime data",
    modelId: "gpt-5.5",
    probePort: 3211,
    probeToken: "p".repeat(64),
    providerBaseUrl: "https://provider.example/v1",
    providerId: "provider-1",
    runtimeGeneration: "runtime-1",
    sessionToken: "s".repeat(64),
    uiOrigin: "http://127.0.0.1:5175",
  });

  assert.deepEqual(
    {
      agentVersionId: environment.CREWON_AGENT_VERSION_ID,
      controlDatabase: environment.CREWON_CONTROL_DB_PATH,
      modelId: environment.CREWON_MODEL_ID,
      nativeWorkspace: environment.CREWON_NATIVE_WORKSPACE_READ_ENABLED,
      providerProbeOrigin: environment.CREWON_PROVIDER_PROBE_WORKER_ORIGIN,
      responsesEndpoint: environment.CREWON_RESPONSES_ENDPOINT,
      runtimeBindings:
        environment.CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH ?? null,
      workspaceBinding: environment.CREWON_WORKSPACE_BINDING_ID ?? null,
    },
    {
      agentVersionId: "agent-version-1",
      controlDatabase: "/runtime data/control.sqlite",
      modelId: "gpt-5.5",
      nativeWorkspace: "0",
      providerProbeOrigin: "http://127.0.0.1:3211",
      responsesEndpoint: "https://provider.example/v1/responses",
      runtimeBindings: "/runtime data/agent-version-runtime-bindings.json",
      workspaceBinding: null,
    },
  );
});

test("versions the local AgentVersion identity with the runtime fingerprint", () => {
  assert.equal(
    developmentAgentVersionId("a".repeat(64)),
    "local-web-aaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.notEqual(
    developmentAgentVersionId("a".repeat(64)),
    developmentAgentVersionId("b".repeat(64)),
  );
  assert.throws(
    () => developmentAgentVersionId("not-a-fingerprint"),
    /fingerprint is invalid/u,
  );
});

test("keeps local runtime concurrency explicit and bounded", () => {
  assert.equal(developmentRuntimeWorkerCount(undefined), 1);
  assert.equal(developmentRuntimeWorkerCount(" 2 "), 2);
  for (const invalid of ["0", "9", "1.5", "many"]) {
    assert.throws(
      () => developmentRuntimeWorkerCount(invalid),
      /CREWON_CONTROL_DEV_RUNTIME_WORKER_COUNT_invalid/u,
    );
  }
});

test("gives each local worker a unique owner and only one probe listener", () => {
  const base = {
    CREWON_PROVIDER_PROBE_PORT: "3211",
    CREWON_PROVIDER_PROBE_TOKEN: "p".repeat(64),
    CREWON_PROVIDER_PROBE_PROVIDER_ID: "provider-1",
    CREWON_PROVIDER_PROBE_RUNTIME_BINDING_ID: "runtime-1",
    CREWON_PROVIDER_PROBE_ENDPOINT: "https://provider.example/v1",
    CREWON_PROVIDER_PROBE_CREDENTIAL_ENVIRONMENT: "CREWON_MODEL_API_KEY",
    CREWON_MODEL_API_KEY: "a".repeat(32),
  };
  const primary = developmentRuntimeWorkerEnvironment(base, 0);
  const secondary = developmentRuntimeWorkerEnvironment(base, 1);

  assert.equal(primary.CREWON_WORKER_OWNER_ID, "control-web-runtime-worker-1");
  assert.equal(primary.CREWON_PROVIDER_PROBE_PORT, "3211");
  assert.equal(
    secondary.CREWON_WORKER_OWNER_ID,
    "control-web-runtime-worker-2",
  );
  assert.equal(secondary.CREWON_PROVIDER_PROBE_PORT, undefined);
  assert.equal(secondary.CREWON_PROVIDER_PROBE_TOKEN, undefined);
  assert.equal(secondary.CREWON_PROVIDER_PROBE_ENDPOINT, undefined);
  assert.equal(secondary.CREWON_MODEL_API_KEY, base.CREWON_MODEL_API_KEY);
  assert.throws(
    () => developmentRuntimeWorkerEnvironment(base, -1),
    /development_runtime_worker_index_invalid/u,
  );
});
