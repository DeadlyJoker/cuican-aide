import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRuntimeBootstrapInputs,
  RUNTIME_BOOTSTRAP_INPUTS_SCHEMA,
  type RuntimeBootstrapInputs,
} from "./runtime-bootstrap-inputs.ts";

function fixture(): RuntimeBootstrapInputs {
  return {
    schemaVersion: RUNTIME_BOOTSTRAP_INPUTS_SCHEMA,
    model: {
      endpoint: "https://api.openai.com/v1/responses",
      modelId: "model-1",
      credentialRequired: true,
      maxOutputTokens: null,
      storeResponses: false,
      requestProfile: "standard",
      idleTimeoutMs: 60000,
      sequencePolicy: "required",
      identityPolicy: "strict",
      outputDeltaFlushBytes: null,
      websocket: null,
    },
    agent: {
      instructions: "Follow the task.\nReport evidence.",
      contextWindowTokens: 273000,
      autoCompactAtTokens: 200000,
      streamMaxRetries: 5,
      maxToolRounds: 32,
    },
    route: {
      authorityId: "authority-1",
      runtimeGeneration: "ts-v0",
      agentVersionId: "agent-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: null,
    },
    modelCatalog: null,
    profiles: [
      {
        agentVersionId: "planner-1",
        instructions: "Plan carefully.\nCheck constraints.",
      },
    ],
    tooling: {
      mcpStdioConfigPath: null,
      desktopWorkspaceRoot: null,
      nativeWorkspaceReadCatalog: "disabled",
    },
  };
}

test("copies and freezes the complete credential-free bootstrap input", () => {
  const input = fixture();
  const parsed = parseRuntimeBootstrapInputs(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.model, input.model);
  for (const value of [
    parsed,
    parsed.model,
    parsed.agent,
    parsed.route,
    parsed.tooling,
    parsed.profiles,
    parsed.profiles[0],
  ])
    assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(
    parseRuntimeBootstrapInputs({
      ...input,
      modelCatalog: ["model-1", "model-2"],
    }).modelCatalog,
    ["model-1", "model-2"],
  );
});

test("rejects unknown and secret fields at every fixed boundary", () => {
  const input = fixture();
  for (const value of [
    { ...input, apiKey: "private" },
    { ...input, schemaVersion: "unknown" },
    { ...input, model: { ...input.model, apiKeyEnvironment: "PRIVATE" } },
    { ...input, agent: { ...input.agent, other: true } },
    { ...input, route: { ...input.route, tenantId: "other" } },
    { ...input, profiles: [{ ...input.profiles[0], cloudAgent: {} }] },
    { ...input, tooling: { ...input.tooling, remoteMcpConfigPath: null } },
    {
      ...input,
      tooling: { ...input.tooling, mcpStdioConfigPath: "/tmp/config" },
    },
    { ...input, route: { ...input.route, workspaceBindingId: "workspace-1" } },
    {
      ...input,
      model: Object.assign(Object.create({ apiKey: "inherited" }), input.model),
    },
  ])
    assert.throws(
      () => parseRuntimeBootstrapInputs(value),
      /runtime_bootstrap_inputs_invalid/,
    );
  let reads = 0;
  const accessor = { ...input.model };
  Object.defineProperty(accessor, "endpoint", {
    enumerable: true,
    get() {
      reads++;
      throw new Error("private");
    },
  });
  assert.throws(
    () => parseRuntimeBootstrapInputs({ ...input, model: accessor }),
    /runtime_bootstrap_inputs_invalid/,
  );
  assert.equal(reads, 0);
});

test("enforces effective gateway profile and native WebSocket settings", () => {
  const input = fixture();
  const gateway = {
    endpoint: "https://gateway.example/v1/responses",
    modelId: "model-1",
    credentialRequired: true,
    maxOutputTokens: 64,
    storeResponses: false,
    requestProfile: "responsesLite",
    idleTimeoutMs: 1234,
    sequencePolicy: "whenPresent",
    identityPolicy: "terminalAuthoritative",
    outputDeltaFlushBytes: 1024,
    websocket: null,
  };
  assert.equal(
    parseRuntimeBootstrapInputs({ ...input, model: gateway }).model
      .identityPolicy,
    "terminalAuthoritative",
  );
  for (const change of [
    { storeResponses: true },
    { requestProfile: "standard" },
    { sequencePolicy: "required" },
    { identityPolicy: "strict" },
    { outputDeltaFlushBytes: null },
    { websocket: { connectTimeoutMs: 100, maxRetries: 0 } },
  ])
    assert.throws(
      () =>
        parseRuntimeBootstrapInputs({
          ...input,
          model: { ...gateway, ...change },
        }),
      /runtime_bootstrap_inputs_invalid/,
    );
  const native = parseRuntimeBootstrapInputs({
    ...input,
    model: {
      ...input.model,
      websocket: { connectTimeoutMs: 1024, maxRetries: 0 },
    },
  });
  assert.equal(Object.isFrozen(native.model.websocket), true);
  assert.equal(native.model.websocket?.maxRetries, 0);
  assert.throws(
    () =>
      parseRuntimeBootstrapInputs({
        ...input,
        model: { ...input.model, outputDeltaFlushBytes: 1024 },
      }),
    /runtime_bootstrap_inputs_invalid/,
  );
});

test("bounds numeric model and execution parameters without accepting absent values", () => {
  const input = fixture();
  for (const value of [
    { ...input, model: { ...input.model, maxOutputTokens: undefined } },
    { ...input, model: { ...input.model, maxOutputTokens: 0 } },
    { ...input, model: { ...input.model, maxOutputTokens: 273001 } },
    { ...input, model: { ...input.model, idleTimeoutMs: 0 } },
    {
      ...input,
      model: {
        ...input.model,
        websocket: { connectTimeoutMs: 1, maxRetries: -1 },
      },
    },
    {
      ...input,
      model: {
        ...input.model,
        websocket: { connectTimeoutMs: 1, maxRetries: 9007199254740992 },
      },
    },
    { ...input, agent: { ...input.agent, autoCompactAtTokens: null } },
    { ...input, agent: { ...input.agent, autoCompactAtTokens: 273000 } },
    { ...input, agent: { ...input.agent, streamMaxRetries: 11 } },
    { ...input, agent: { ...input.agent, maxToolRounds: 33 } },
  ])
    assert.throws(
      () => parseRuntimeBootstrapInputs(value),
      /runtime_bootstrap_inputs_invalid/,
    );
});

test("rejects credential-bearing endpoints and preserves exact valid endpoint paths", () => {
  const input = fixture();
  for (const endpoint of [
    "file:///tmp/model",
    "https://user:password@api.openai.com/v1/responses",
    "https://api.openai.com/v1/responses?key=private",
    "https://api.openai.com/v1/responses#private",
    "not a url",
    "https://api.openai.com/" + "a".repeat(4096),
  ])
    assert.throws(
      () =>
        parseRuntimeBootstrapInputs({
          ...input,
          model: { ...input.model, endpoint },
        }),
      /runtime_bootstrap_inputs_invalid/,
    );
  assert.equal(
    parseRuntimeBootstrapInputs({
      ...input,
      model: {
        ...input.model,
        endpoint: "https://api.openai.com:443/v1/responses/",
      },
    }).model.endpoint,
    "https://api.openai.com:443/v1/responses/",
  );
});

test("bounds UTF-8 text, serialized bytes, and unique effective catalogs and profiles", () => {
  const input = fixture();
  for (const value of [
    { ...input, agent: { ...input.agent, instructions: "图".repeat(11000) } },
    {
      ...input,
      agent: { ...input.agent, instructions: "\u0000".repeat(32768) },
    },
    {
      ...input,
      profiles: [
        { agentVersionId: "planner-1", instructions: "图".repeat(3334) },
      ],
    },
    { ...input, modelCatalog: [] },
    { ...input, modelCatalog: ["different", "model-1"] },
    { ...input, modelCatalog: ["model-1", "model-1"] },
    {
      ...input,
      modelCatalog: Array.from({ length: 25 }, (_, i) =>
        i === 0 ? "model-1" : `model-${i + 1}`,
      ),
    },
    { ...input, profiles: [input.profiles[0], input.profiles[0]] },
    {
      ...input,
      profiles: [
        { agentVersionId: "agent-1", instructions: "duplicate bootstrap" },
      ],
    },
    {
      ...input,
      profiles: Array.from({ length: 9 }, (_, i) => ({
        agentVersionId: `agent-${i + 2}`,
        instructions: "other",
      })),
    },
    { ...input, route: { ...input.route, authorityId: "a\nheader" } },
  ])
    assert.throws(
      () => parseRuntimeBootstrapInputs(value),
      /runtime_bootstrap_inputs_invalid/,
    );
});
