import assert from "node:assert/strict";
import test from "node:test";

import { AgentKernelError } from "@crewon/agent-kernel";
import type { RuntimeBootstrapInputs } from "@crewon/contracts";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import {
  replayRuntimeBootstrapInputs as sharedReplayRuntimeBootstrapInputs,
  RUNTIME_BOOTSTRAP_ENVIRONMENT_CLEAR_NAMES as SHARED_CLEAR_NAMES,
} from "@crewon/contracts/runtime";

import {
  compileRuntimeAgentVersion,
  compileRuntimeAgentVersionRelease,
} from "./agent-version-release.ts";
import {
  compileDevelopmentAgentProfileVersion,
  developmentAgentRuntimeBindings,
  parseDevelopmentAgentProfiles,
} from "./development-agent-profiles.ts";
import { resolveResponsesRuntimeConfiguration } from "./responses-runtime-configuration.ts";
import {
  captureRuntimeBootstrapInputs,
  replayRuntimeBootstrapInputs,
  RUNTIME_BOOTSTRAP_ENVIRONMENT_CLEAR_NAMES,
} from "./runtime-bootstrap-inputs.ts";
import {
  resolveRuntimeBootstrapAgent,
  resolveRuntimeBootstrapRoute,
} from "./runtime-bootstrap-defaults.ts";
import type { RuntimeEnvironment } from "./runtime-environment-values.ts";
import { createModelTransport } from "./runtime-process-environment.ts";
import {
  modelVariantAgentVersionId,
  runtimeModelCatalog,
} from "./runtime-model-catalog.ts";
import {
  agentVersionDeploymentCandidates,
  createAgentVersionRuntimeFactory,
} from "./runtime-binding-config.ts";

const BASE = Object.freeze({
  CREWON_MODEL_ID: "model-old",
  CREWON_RESPONSES_ENDPOINT: "https://api.openai.com/v1/responses",
});

function capture(
  environment: RuntimeEnvironment = BASE,
): RuntimeBootstrapInputs {
  const result = captureRuntimeBootstrapInputs(environment);
  assert.equal(result.outcome, "eligible");
  if (result.outcome !== "eligible") throw new Error("fixture_ineligible");
  return result.inputs;
}

test("Worker compatibility exports preserve the shared projection and its stricter effective replay gate", () => {
  const inputs = capture();
  assert.equal(RUNTIME_BOOTSTRAP_ENVIRONMENT_CLEAR_NAMES, SHARED_CLEAR_NAMES);
  assert.deepEqual(
    replayRuntimeBootstrapInputs(inputs),
    sharedReplayRuntimeBootstrapInputs(inputs),
  );
  const unreplayable = {
    ...inputs,
    modelCatalog: ["model-old", "gpt-image-1"],
  };
  assert.equal(
    sharedReplayRuntimeBootstrapInputs(unreplayable).CREWON_MODEL_CATALOG_JSON,
    '["model-old","gpt-image-1"]',
  );
  assert.throws(
    () => replayRuntimeBootstrapInputs(unreplayable),
    /runtime_bootstrap_inputs_unreplayable/u,
  );
});

function applyReplay(
  inputs: RuntimeBootstrapInputs,
  ambient: RuntimeEnvironment = {},
): Record<string, string | undefined> {
  const environment = { ...ambient };
  for (const name of RUNTIME_BOOTSTRAP_ENVIRONMENT_CLEAR_NAMES)
    delete environment[name];
  Object.assign(environment, replayRuntimeBootstrapInputs(inputs));
  return environment;
}

test("captures actual defaults and leaves the legacy output ceiling unset", async () => {
  const inputs = capture();
  assert.deepEqual(inputs.agent, {
    instructions: null,
    contextWindowTokens: 273000,
    autoCompactAtTokens: 200000,
    streamMaxRetries: 5,
    maxToolRounds: 32,
  });
  assert.deepEqual(inputs.route, {
    authorityId: "standalone-authority",
    runtimeGeneration: "ts-v0",
    agentVersionId: "default-agent-v1",
    policySnapshotId: "standalone-policy-v0",
    workspaceBindingId: null,
  });
  assert.equal(inputs.model.maxOutputTokens, null);
  assert.equal(inputs.model.websocket, null);
  assert.equal(inputs.modelCatalog, null);
  assert.equal(
    Object.hasOwn(
      replayRuntimeBootstrapInputs(inputs),
      "CREWON_RESPONSES_MAX_OUTPUT_TOKENS",
    ),
    false,
  );
  const transport = createModelTransport(
    "responses",
    {},
    replayRuntimeBootstrapInputs(inputs),
  );
  try {
    const version = compileRuntimeAgentVersion({
      runtimeTenantId: "tenant-1",
      route: inputs.route,
      transport,
    });
    assert.equal(Object.hasOwn(version.model, "maxOutputTokens"), false);
    assert.equal(transport.adapterVersion, "1");
    assert.deepEqual(version.execution, {
      streamMaxRetries: inputs.agent.streamMaxRetries,
      maxToolRounds: inputs.agent.maxToolRounds,
    });
    assert.equal(
      version.model.contextWindowTokens,
      inputs.agent.contextWindowTokens,
    );
    assert.equal(
      version.model.autoCompactAtTokens,
      inputs.agent.autoCompactAtTokens,
    );
  } finally {
    await transport.close?.();
  }
});

test("the shared resolver preserves gateway overrides and ignores unused invalid raw settings", async () => {
  const environment = {
    ...BASE,
    CREWON_RESPONSES_ENDPOINT: "https://gateway.example/tenant/v1/responses",
    CREWON_RESPONSES_MAX_OUTPUT_TOKENS: "256",
    CREWON_RESPONSES_STORE: "invalid-unused",
    CREWON_RESPONSES_REQUEST_PROFILE: "responsesLite",
    CREWON_RESPONSES_SEQUENCE_POLICY: "invalid-unused",
    CREWON_RESPONSES_WEBSOCKET_ENABLED: "invalid-unused",
    CREWON_RESPONSES_WEBSOCKET_CONNECT_TIMEOUT_MS: "invalid-unused",
    CREWON_RESPONSES_WEBSOCKET_MAX_RETRIES: "invalid-unused",
    CREWON_RESPONSES_IDLE_TIMEOUT_MS: "4321",
  };
  const inputs = capture(environment);
  assert.deepEqual(inputs.model, {
    endpoint: environment.CREWON_RESPONSES_ENDPOINT,
    modelId: "model-old",
    credentialRequired: true,
    maxOutputTokens: 256,
    storeResponses: false,
    requestProfile: "responsesLite",
    sequencePolicy: "whenPresent",
    identityPolicy: "terminalAuthoritative",
    outputDeltaFlushBytes: null,
    idleTimeoutMs: 4321,
    websocket: null,
  });
  assert.deepEqual(capture(replayRuntimeBootstrapInputs(inputs)), inputs);
  const transport = createModelTransport(
    "responses",
    { providerId: "openai" },
    environment,
  );
  try {
    assert.equal(transport.adapterVersion, "1+responses-lite");
    assert.equal(transport.maxOutputTokens, 256);
    assert.equal(transport.supportsResponseRetrieve, false);
    const {
      modelId,
      websocket,
      credentialRequired,
      outputDeltaFlushBytes,
      ...effective
    } = inputs.model;
    assert.equal(outputDeltaFlushBytes, null);
    assert.deepEqual(resolveResponsesRuntimeConfiguration(environment).config, {
      ...effective,
      model: modelId,
    });
  } finally {
    await transport.close?.();
  }
});

for (const profileSelection of ["default", "explicit"] as const) {
  test(`${profileSelection} gateway Standard survives capture, replay, release compilation and runtime materialization`, () =>
    verifyGatewayStandardRelease(profileSelection));
}

async function verifyGatewayStandardRelease(
  profileSelection: "default" | "explicit",
): Promise<void> {
  const environment = {
    ...BASE,
    CREWON_RESPONSES_ENDPOINT: "https://gateway.example/v1/responses",
    ...(profileSelection === "default"
      ? {}
      : { CREWON_RESPONSES_REQUEST_PROFILE: "standard" }),
    CREWON_MODEL_CREDENTIAL_REQUIRED: "0",
    CREWON_MODEL_CATALOG_JSON: '["model-old","model-new"]',
    CREWON_DEV_AGENT_PROFILES_JSON:
      '[{"agentVersionId":"planner","instructions":"Plan carefully."}]',
  };
  const inputs = capture(environment);
  assert.equal(inputs.model.requestProfile, "standard");
  assert.equal(inputs.model.storeResponses, false);
  assert.equal(inputs.model.sequencePolicy, "whenPresent");
  assert.equal(inputs.model.identityPolicy, "terminalAuthoritative");
  const replay = applyReplay(inputs, {
    CREWON_RESPONSES_REQUEST_PROFILE: "responsesLite",
  });
  assert.deepEqual(capture(replay), inputs);
  const before = await compileReleaseFixture(environment);
  const after = await compileReleaseFixture(replay);
  assert.deepEqual(after, before);
  assert.equal(after.versions.length, 4);
  for (const version of after.versions) {
    assert.equal(version.model.adapterVersion, "1");
    const binding = after.runtimeBindings.bindings.find(
      (item) => item.agentVersionId === version.agentVersionId,
    );
    assert.ok(binding);
    assert.equal(binding.contentDigest, version.contentDigest);
    assert.equal(binding.provider.requestProfile, "standard");
    assert.equal(binding.provider.storeResponses, false);
    assert.equal(binding.provider.sequencePolicy, "whenPresent");
  }
  const lite = await compileReleaseFixture({
    ...environment,
    CREWON_RESPONSES_REQUEST_PROFILE: "responsesLite",
  });
  assert.notEqual(
    after.bootstrapVersion.contentDigest,
    lite.bootstrapVersion.contentDigest,
  );
  assert.notEqual(
    after.deployments[1]?.materializationDigest,
    lite.deployments[1]?.materializationDigest,
  );

  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (_url, init) => {
    methods.push(init?.method ?? "GET");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.store, false);
    assert.equal(Object.hasOwn(body, "reasoning"), false);
    assert.equal(Object.hasOwn(body, "parallel_tool_calls"), false);
    assert.equal(Object.hasOwn(body, "previous_response_id"), false);
    return new Response(
      [
        { type: "response.created", response: { id: "response-profile" } },
        { type: "response.output_text.delta", delta: "answer" },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        },
        {
          type: "response.completed",
          response: {
            id: "response-profile",
            status: "completed",
            output: [],
          },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
  };
  try {
    const factory = createAgentVersionRuntimeFactory({
      config: after.runtimeBindings,
      environment: replay,
    }).bindSharedToolRuntime(new InMemoryToolBroker([]));
    const samplingFailures: { agentVersionId: string; code: string }[] = [];
    for (const version of after.versions) {
      const runtime = await factory.create({ tenantId: "tenant-1", version });
      try {
        assert.deepEqual(runtime.kernel.modelIdentity, {
          adapterName: version.model.adapterName,
          adapterVersion: version.model.adapterVersion,
          modelId: version.model.modelId,
        });
        const events = [];
        try {
          for await (const event of runtime.kernel.runSegment(
            {
              schemaVersion: "crewon.agent-segment.v0",
              purpose: "agent",
              runId: `run-${version.agentVersionId}`,
              segmentId: "segment-profile",
              attempt: 1,
              agentVersionId: version.agentVersionId,
              policySnapshotId: version.policySnapshotId,
              collaborationMode: "default",
              allowedTools: null,
              history: [{ type: "message", role: "user", content: "hello" }],
              continuation: { kind: "manual" },
              budget: { maxOutputBytes: 8192 },
            },
            new AbortController().signal,
          ))
            events.push(event);
        } catch (error) {
          assert.ok(error instanceof AgentKernelError);
          samplingFailures.push({
            agentVersionId: version.agentVersionId,
            code: error.code,
          });
        }
        if (
          samplingFailures.at(-1)?.agentVersionId !== version.agentVersionId
        ) {
          assert.equal(events.at(-1)?.type, "segment.completed");
          assert.deepEqual(events.at(-1)?.data, { output: "answer" });
          assert.equal(
            events.filter((event) => event.type === "segment.completed").length,
            1,
          );
          assert.deepEqual(
            events.flatMap((event) =>
              event.type === "model.output.delta" ? [event.data.delta] : [],
            ),
            ["answer"],
          );
        }
        assert.equal(
          events.filter((event) => event.type === "model.sampling.retry")
            .length,
          0,
        );
      } finally {
        await runtime.close?.();
      }
    }
    assert.deepEqual(methods, ["POST", "POST", "POST", "POST"]);
    assert.deepEqual(samplingFailures, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("gateway Standard output is immediate by default and saved Lite/1024 bootstrap replay remains exact", async () => {
  const environment = {
    ...BASE,
    CREWON_RESPONSES_ENDPOINT: "https://gateway.example/v1/responses",
  };
  const current = capture(environment);
  assert.equal(current.model.requestProfile, "standard");
  assert.equal(current.model.outputDeltaFlushBytes, null);
  assert.equal(
    Object.hasOwn(
      resolveResponsesRuntimeConfiguration(environment).config,
      "outputDeltaFlushBytes",
    ),
    false,
  );
  const legacy = {
    ...current,
    model: {
      ...current.model,
      requestProfile: "responsesLite" as const,
      outputDeltaFlushBytes: 1024,
    },
  };
  const replay = replayRuntimeBootstrapInputs(legacy);
  assert.equal(replay.CREWON_RESPONSES_REQUEST_PROFILE, "responsesLite");
  assert.equal(replay.CREWON_RESPONSES_OUTPUT_DELTA_FLUSH_BYTES, "1024");
  assert.deepEqual(capture(replay), legacy);
  const oldRelease = await compileReleaseFixture({
    ...environment,
    CREWON_RESPONSES_REQUEST_PROFILE: "responsesLite",
    CREWON_RESPONSES_OUTPUT_DELTA_FLUSH_BYTES: "1024",
  });
  assert.equal(
    oldRelease.bootstrapVersion.model.adapterVersion,
    "1+responses-lite",
  );
  assert.deepEqual(await compileReleaseFixture(replay), oldRelease);
  const restoredCurrent = applyReplay(current, replay);
  assert.equal(
    Object.hasOwn(restoredCurrent, "CREWON_RESPONSES_OUTPUT_DELTA_FLUSH_BYTES"),
    false,
  );
  assert.deepEqual(capture(restoredCurrent), current);
  for (const value of ["0", "25", "2048", "invalid"])
    assert.throws(
      () =>
        resolveResponsesRuntimeConfiguration({
          ...environment,
          CREWON_RESPONSES_OUTPUT_DELTA_FLUSH_BYTES: value,
        }),
      /CREWON_RESPONSES_OUTPUT_DELTA_FLUSH_BYTES_invalid/u,
    );
  assert.throws(
    () =>
      resolveResponsesRuntimeConfiguration({
        ...BASE,
        CREWON_RESPONSES_OUTPUT_DELTA_FLUSH_BYTES: "1024",
      }),
    /CREWON_RESPONSES_OUTPUT_DELTA_FLUSH_BYTES_invalid/u,
  );
});

test("captures native WebSocket limits and recreates its distinct compiled model identity", async () => {
  const inputs = capture({
    ...BASE,
    CREWON_RESPONSES_STORE: "true",
    CREWON_RESPONSES_REQUEST_PROFILE: "responsesLite",
    CREWON_RESPONSES_SEQUENCE_POLICY: "whenPresent",
    CREWON_RESPONSES_WEBSOCKET_ENABLED: "true",
    CREWON_RESPONSES_WEBSOCKET_CONNECT_TIMEOUT_MS: "8765",
    CREWON_RESPONSES_WEBSOCKET_MAX_RETRIES: "0",
    CREWON_RESPONSES_MAX_OUTPUT_TOKENS: "128",
    CREWON_RESPONSES_IDLE_TIMEOUT_MS: "4321",
  });
  assert.deepEqual(inputs.model.websocket, {
    connectTimeoutMs: 8765,
    maxRetries: 0,
  });
  assert.equal(inputs.model.identityPolicy, "strict");
  assert.equal(inputs.model.outputDeltaFlushBytes, null);
  const replay = replayRuntimeBootstrapInputs(inputs);
  const transport = createModelTransport(
    "responses",
    { providerId: "gateway-name" },
    replay,
  );
  try {
    assert.equal(transport.adapterVersion, "2+responses-lite");
    assert.equal(
      resolveResponsesRuntimeConfiguration(replay).config.storeResponses,
      true,
    );
    assert.equal(transport.maxOutputTokens, 128);
    assert.deepEqual(capture(replay), inputs);
  } finally {
    await transport.close?.();
  }
});

test("keeps catalog declaration ownership while saving only the effective filtered models", () => {
  const inputs = capture({
    ...BASE,
    CREWON_MODEL_CATALOG_JSON: JSON.stringify([
      "model-new",
      "model-old",
      "gpt-image-1",
      "model-new",
      4,
      "model-third",
    ]),
  });
  assert.deepEqual(inputs.modelCatalog, [
    "model-old",
    "model-new",
    "model-third",
  ]);
  for (const raw of [
    "",
    "bad json",
    "{}",
    JSON.stringify(Array.from({ length: 101 }, (_, i) => `model-${i}`)),
  ]) {
    const fallback = capture({ ...BASE, CREWON_MODEL_CATALOG_JSON: raw });
    assert.deepEqual(fallback.modelCatalog, ["model-old"]);
    assert.equal(
      Object.hasOwn(
        replayRuntimeBootstrapInputs(fallback),
        "CREWON_MODEL_CATALOG_JSON",
      ),
      true,
    );
  }
  assert.equal(
    Object.hasOwn(
      replayRuntimeBootstrapInputs(capture(BASE)),
      "CREWON_MODEL_CATALOG_JSON",
    ),
    false,
  );
});

test("replay removes ambient compiler, catalog, profile, and tool drift before rebuilding the same complete release", async () => {
  const original = {
    ...BASE,
    CREWON_MODEL_CREDENTIAL_REQUIRED: "0",
    CREWON_AGENT_INSTRUCTIONS: "  Original instructions.\nPreserve evidence.  ",
    CREWON_MODEL_CONTEXT_WINDOW_TOKENS: "16000",
    CREWON_AUTO_COMPACT_AT_TOKENS: "8000",
    CREWON_RESPONSES_STREAM_MAX_RETRIES: "0",
    CREWON_RESPONSES_MAX_OUTPUT_TOKENS: "512",
    CREWON_RESPONSES_STORE: "true",
    CREWON_RESPONSES_IDLE_TIMEOUT_MS: "7654",
    CREWON_RESPONSES_WEBSOCKET_ENABLED: "true",
    CREWON_RESPONSES_WEBSOCKET_CONNECT_TIMEOUT_MS: "2345",
    CREWON_RESPONSES_WEBSOCKET_MAX_RETRIES: "4",
    CREWON_AUTHORITY_ID: "old-authority",
    CREWON_RUNTIME_GENERATION: "old-generation",
    CREWON_AGENT_VERSION_ID: "old-agent",
    CREWON_POLICY_SNAPSHOT_ID: "old-policy",
    CREWON_MODEL_CATALOG_JSON: '["model-old","model-new","model-third"]',
    CREWON_DEV_AGENT_PROFILES_JSON:
      '[{"agentVersionId":"old-planner","instructions":"  Exact profile instructions.  "}]',
  };
  const inputs = capture(original);
  const drift: Record<string, string | undefined> = Object.fromEntries(
    RUNTIME_BOOTSTRAP_ENVIRONMENT_CLEAR_NAMES.map((name) => [
      name,
      "drifted-invalid",
    ]),
  );
  drift.CREWON_MODEL_API_KEY = "current-rotated-key";
  drift.CREWON_CONTROL_DB_PATH = "/current/db.sqlite";
  drift.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH =
    "/current/pinned-bindings.json";
  const replay = applyReplay(inputs, drift);
  assert.equal(inputs.model.credentialRequired, false);
  assert.equal(replay.CREWON_MODEL_CREDENTIAL_REQUIRED, "0");
  assert.equal(replay.CREWON_MODEL_API_KEY, "current-rotated-key");
  assert.equal(replay.CREWON_CONTROL_DB_PATH, "/current/db.sqlite");
  assert.equal(
    replay.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH,
    "/current/pinned-bindings.json",
  );
  assert.equal(replay.CREWON_MCP_STDIO_CONFIG_PATH, undefined);
  assert.equal(replay.CREWON_DEVICE_TOOL_CONFIG_PATH, undefined);
  assert.equal(replay.CREWON_DESKTOP_WORKSPACE_ROOT, undefined);
  assert.deepEqual(capture(replay), inputs);
  const before = await compileReleaseFixture(original);
  const after = await compileReleaseFixture(replay);
  assert.deepEqual(after, before);
  assert.equal(after.versions.length, 6);
  assert.equal(after.bootstrapVersion.model.adapterVersion, "2");
  assert.equal(
    after.bootstrapVersion.instructions,
    "Original instructions.\nPreserve evidence.",
  );
  assert.equal(
    after.versions.find((version) => version.agentVersionId === "old-planner")
      ?.instructions,
    "  Exact profile instructions.  ",
  );
  assert.equal(after.bootstrapVersion.model.maxOutputTokens, 512);
  const authenticated = await compileReleaseFixture({
    ...original,
    CREWON_MODEL_CREDENTIAL_REQUIRED: "1",
  });
  assert.equal(
    authenticated.bootstrapVersion.contentDigest,
    before.bootstrapVersion.contentDigest,
  );
  assert.notEqual(
    authenticated.deployments[1]?.materializationDigest,
    before.deployments[1]?.materializationDigest,
  );
});

test("replay clears absent optional output/instructions/catalog and disabled WebSocket knobs", () => {
  const inputs = capture();
  const replay = applyReplay(inputs, {
    CREWON_RESPONSES_MAX_OUTPUT_TOKENS: "100",
    CREWON_AGENT_INSTRUCTIONS: "new",
    CREWON_MODEL_CATALOG_JSON: '["new"]',
    CREWON_RESPONSES_WEBSOCKET_ENABLED: "true",
    CREWON_RESPONSES_WEBSOCKET_CONNECT_TIMEOUT_MS: "invalid",
    CREWON_RESPONSES_WEBSOCKET_MAX_RETRIES: "invalid",
  });
  assert.equal(replay.CREWON_RESPONSES_MAX_OUTPUT_TOKENS, undefined);
  assert.equal(replay.CREWON_AGENT_INSTRUCTIONS, undefined);
  assert.equal(replay.CREWON_MODEL_CATALOG_JSON, undefined);
  assert.equal(replay.CREWON_RESPONSES_WEBSOCKET_CONNECT_TIMEOUT_MS, undefined);
  assert.equal(replay.CREWON_RESPONSES_WEBSOCKET_MAX_RETRIES, undefined);
  assert.equal(replay.CREWON_RESPONSES_WEBSOCKET_ENABLED, "false");
  assert.deepEqual(capture(replay), inputs);
});

test("never reads, saves, or emits model/current-authority secret slots", () => {
  const environment: Record<string, string | undefined> = { ...BASE };
  for (const name of [
    "CREWON_MODEL_API_KEY",
    "CREWON_AGENT_PLATFORM_API_KEY",
    "CREWON_CONTROL_DB_PATH",
    "CREWON_RUNTIME_NATIVE_PRIVATE_TOKEN",
    "CREWON_ARTIFACT_KEY",
    "CREWON_PROVIDER_PROBE_TOKEN",
    "CREWON_CONTROL_SESSION_TOKEN",
    "UNRECOGNIZED_SECRET",
  ])
    Object.defineProperty(environment, name, {
      get() {
        throw new Error(`should_not_read_${name}`);
      },
    });
  const inputs = capture(environment);
  const replay = replayRuntimeBootstrapInputs(inputs);
  assert.equal(
    Object.keys(replay).every((name) =>
      (RUNTIME_BOOTSTRAP_ENVIRONMENT_CLEAR_NAMES as readonly string[]).includes(
        name,
      ),
    ),
    true,
  );
  assert.equal(JSON.stringify(inputs).includes("should_not_read"), false);
  assert.equal(JSON.stringify(replay).includes("secret"), false);
  const snapshot = capture({
    ...BASE,
    CREWON_MODEL_API_KEY: "old-key",
    CREWON_ARTIFACT_KEY: "old-artifact-key",
    CREWON_CONTROL_SESSION_TOKEN: "old-session-token",
  });
  assert.deepEqual(snapshot, inputs);
});

test("unsupported recovery leaves ordinary fake, gateway, and tool startup available", async () => {
  const tool = {
    ...BASE,
    CREWON_MCP_STDIO_CONFIG_PATH: "/not-opened/config.json",
  };
  assert.deepEqual(captureRuntimeBootstrapInputs(tool), {
    outcome: "unsupported",
    reasonCode: "runtime_bootstrap_tooling_unsupported",
  });
  const gateway = createModelTransport(
    "responses",
    {},
    {
      ...tool,
      CREWON_RESPONSES_ENDPOINT: "https://gateway.example/v1/responses",
    },
  );
  try {
    assert.equal(gateway.adapterVersion, "1");
  } finally {
    await gateway.close?.();
  }
  const fakeEnvironment = {
    CREWON_MODEL_ADAPTER: "deterministic-fake",
    CREWON_FAKE_EXPECTED_USER_MESSAGE: "hello",
    CREWON_FAKE_RESPONSE: "ordinary fake output",
  };
  assert.deepEqual(captureRuntimeBootstrapInputs(fakeEnvironment), {
    outcome: "unsupported",
    reasonCode: "runtime_bootstrap_model_adapter_unsupported",
  });
  const fake = createModelTransport("deterministic-fake", {}, fakeEnvironment);
  const events = [];
  for await (const event of fake.stream(
    {
      schemaVersion: "crewon.model-request.v0",
      runId: "run-1",
      segmentId: "segment-1",
      agentVersionId: "agent-1",
      instructions: null,
      input: {
        strategy: "manual",
        items: [{ type: "message", role: "user", content: "hello" }],
      },
      tools: [],
      maxOutputBytes: 1024,
    },
    new AbortController().signal,
  ))
    events.push(event);
  assert.deepEqual(events[0], {
    type: "output.delta",
    delta: "ordinary fake output",
  });
});

test("tool, workspace, and cloud profile exclusions return fixed nonsecret reasons", () => {
  for (const name of [
    "CREWON_MCP_STDIO_CONFIG_PATH",
    "CREWON_DEVICE_TOOL_CONFIG_PATH",
    "CREWON_PIM_SANDBOX_BASE_URL",
    "CREWON_PIM_SANDBOX_USERNAME",
    "CREWON_PIM_SANDBOX_PASSWORD",
    "CREWON_PIM_SANDBOX_AGENT_ID",
  ])
    assert.deepEqual(
      captureRuntimeBootstrapInputs({ ...BASE, [name]: "private-canary" }),
      {
        outcome: "unsupported",
        reasonCode: "runtime_bootstrap_tooling_unsupported",
      },
    );
  for (const environment of [
    { CREWON_DESKTOP_WORKSPACE_ROOT: "/workspace" },
    { CREWON_WORKSPACE_BINDING_ID: "workspace-1" },
    { CREWON_NATIVE_WORKSPACE_READ_ENABLED: "1" },
  ])
    assert.deepEqual(
      captureRuntimeBootstrapInputs({ ...BASE, ...environment }),
      {
        outcome: "unsupported",
        reasonCode: "runtime_bootstrap_workspace_unsupported",
      },
    );
  const cloud = JSON.stringify([
    {
      agentVersionId: "cloud-1",
      instructions: "",
      cloudAgent: {
        invocationUrl: "https://cloud.example/invoke",
        modelId: "cloud-model",
        agentId: 1,
      },
    },
  ]);
  assert.deepEqual(
    captureRuntimeBootstrapInputs({
      ...BASE,
      CREWON_DEV_AGENT_PROFILES_JSON: cloud,
    }),
    {
      outcome: "unsupported",
      reasonCode: "runtime_bootstrap_cloud_profiles_unsupported",
    },
  );
});

test("invalid effective parameters stay unsupported without leaking invalid text", () => {
  for (const environment of [
    { CREWON_MODEL_ID: "" },
    {
      CREWON_RESPONSES_ENDPOINT:
        "https://user:private-canary@model.example/responses",
    },
    { CREWON_RESPONSES_MAX_OUTPUT_TOKENS: "0" },
    { CREWON_RESPONSES_MAX_OUTPUT_TOKENS: "1.5" },
    { CREWON_RESPONSES_STORE: "private-canary" },
    { CREWON_RESPONSES_WEBSOCKET_ENABLED: "private-canary" },
    {
      CREWON_RESPONSES_WEBSOCKET_ENABLED: "true",
      CREWON_RESPONSES_WEBSOCKET_MAX_RETRIES: "-1",
    },
    { CREWON_RESPONSES_IDLE_TIMEOUT_MS: "0" },
    { CREWON_AUTO_COMPACT_AT_TOKENS: "300000" },
    { CREWON_RESPONSES_STREAM_MAX_RETRIES: "11" },
    { CREWON_DEV_AGENT_PROFILES_JSON: "private-canary" },
  ])
    assert.deepEqual(
      captureRuntimeBootstrapInputs({ ...BASE, ...environment }),
      {
        outcome: "unsupported",
        reasonCode: "runtime_bootstrap_configuration_unsupported",
      },
    );
});

test("replay strictly rejects extra fields and effective catalogs that cannot round trip", () => {
  const inputs = capture();
  assert.throws(
    () =>
      replayRuntimeBootstrapInputs({
        ...inputs,
        model: { ...inputs.model, apiKey: "private" },
      } as RuntimeBootstrapInputs),
    /runtime_bootstrap_inputs_invalid/,
  );
  assert.throws(
    () =>
      replayRuntimeBootstrapInputs({
        ...inputs,
        modelCatalog: ["model-old", "gpt-image-1"],
      }),
    /runtime_bootstrap_inputs_unreplayable/,
  );
});

/** Exercises the actual compilers/binding digester used by Release without a provider request. */
async function compileReleaseFixture(environment: RuntimeEnvironment) {
  const transport = createModelTransport("responses", {}, environment);
  try {
    const agent = resolveRuntimeBootstrapAgent(environment);
    const route = resolveRuntimeBootstrapRoute(environment);
    const common = {
      runtimeTenantId: "tenant-1",
      route,
      transport,
      agentInstructions: agent.instructions,
      modelContextWindowTokens: agent.contextWindowTokens,
      autoCompactAtTokens: agent.autoCompactAtTokens,
      streamMaxRetries: agent.streamMaxRetries,
      maxToolRounds: agent.maxToolRounds,
      nativeWorkspaceReadCatalog: "disabled" as const,
    };
    const profiles = parseDevelopmentAgentProfiles(
      environment.CREWON_DEV_AGENT_PROFILES_JSON,
    );
    const bootstrap = compileRuntimeAgentVersion(common);
    const profileVersions = profiles.map((profile) =>
      compileDevelopmentAgentProfileVersion(common, profile),
    );
    const sources = [
      {
        agentVersionId: route.agentVersionId,
        instructions: agent.instructions,
      },
      ...profiles.map((profile) => ({
        agentVersionId: profile.agentVersionId,
        instructions: profile.instructions,
      })),
    ];
    const modelVersions = runtimeModelCatalog(
      environment.CREWON_MODEL_CATALOG_JSON,
      transport.modelId,
    ).flatMap((modelId) =>
      modelId === transport.modelId
        ? []
        : sources.flatMap((source) => {
            const agentVersionId = modelVariantAgentVersionId(
              source.agentVersionId,
              modelId,
            );
            return agentVersionId === null
              ? []
              : [
                  compileRuntimeAgentVersion({
                    ...common,
                    route: { ...route, agentVersionId },
                    agentInstructions: source.instructions,
                    modelId,
                  }),
                ];
          }),
    );
    const additionalAgentVersions = [...profileVersions, ...modelVersions];
    const resolved = resolveResponsesRuntimeConfiguration(environment).config;
    const bindings = developmentAgentRuntimeBindings({
      versions: [bootstrap, ...additionalAgentVersions],
      profiles: [undefined, ...profiles, ...modelVersions.map(() => undefined)],
      tenantId: common.runtimeTenantId,
      authorityId: route.authorityId,
      workspaceBindingId: route.workspaceBindingId,
      endpoint: resolved.endpoint,
      requestProfile: resolved.requestProfile,
      sequencePolicy: resolved.sequencePolicy,
      idleTimeoutMs: resolved.idleTimeoutMs,
      directApiKeyEnvironment:
        environment.CREWON_MODEL_CREDENTIAL_REQUIRED === "0"
          ? null
          : "CREWON_MODEL_API_KEY",
      toolRuntimeMode: "shared",
    });
    const deployments = agentVersionDeploymentCandidates(bindings).filter(
      (deployment) => deployment.agentVersionId !== route.agentVersionId,
    );
    return {
      ...compileRuntimeAgentVersionRelease({
        ...common,
        additionalAgentVersions,
        agentVersionDeployments: deployments,
      }),
      runtimeBindings: bindings,
    };
  } finally {
    await transport.close?.();
  }
}

test("bootstrap refuses an advertised directory that no longer contains its configured default", () => {
  const result = captureRuntimeBootstrapInputs({
    ...BASE,
    CREWON_MODEL_CATALOG_JSON: JSON.stringify(["model-new"]),
  });
  assert.equal(result.outcome, "unsupported");
  assert.equal(
    result.reasonCode,
    "runtime_bootstrap_configuration_unsupported",
  );
});
