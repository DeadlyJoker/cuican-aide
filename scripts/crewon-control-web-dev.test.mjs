import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createControlDevEnvironment,
  defaultControlDataDirectory,
  persistentDevelopmentAgentVersionId,
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

test("keeps the local AgentVersion identity stable across runtime rebuilds", () => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-agent-identity-"));
  try {
    writeFileSync(
      join(directory, "agent-version-runtime-bindings.json"),
      JSON.stringify({
        bindings: [
          { agentVersionId: "local-web-existing" },
          { agentVersionId: "local-web-existing-planner" },
        ],
      }),
    );

    assert.equal(
      persistentDevelopmentAgentVersionId(directory, "local-web-new-build"),
      "local-web-existing",
    );
    assert.equal(
      persistentDevelopmentAgentVersionId(directory, "local-web-next-build"),
      "local-web-existing",
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});
