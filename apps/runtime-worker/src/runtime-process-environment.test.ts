import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createConfiguredToolRuntime,
  createModelTransport,
  responsesCompatibilityProfile,
} from "./runtime-process-environment.ts";

test("composes the desktop workspace command into the released tool catalog", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-command-catalog-"));
  try {
    const runtime = await createConfiguredToolRuntime({
      CREWON_DESKTOP_WORKSPACE_ROOT: directory,
    });
    assert.deepEqual(
      runtime?.definitions().map(({ name }) => name),
      ["workspace_run_command"],
    );
    await runtime?.close?.();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uses the native Responses contract only for OpenAI endpoints", () => {
  assert.equal(responsesCompatibilityProfile("openai"), null);
  assert.equal(responsesCompatibilityProfile("openai-api"), null);
  assert.equal(responsesCompatibilityProfile(null), null);
  assert.equal(
    responsesCompatibilityProfile(
      "custom-openai-name",
      "https://api.openai.com/v1/responses",
    ),
    null,
  );
});

test("uses the portable Responses subset for LiteLLM and third-party gateways", () => {
  assert.deepEqual(responsesCompatibilityProfile("litellm"), {
    requestProfile: "standard",
    sequencePolicy: "whenPresent",
  });
  assert.deepEqual(responsesCompatibilityProfile("private-gateway"), {
    requestProfile: "standard",
    sequencePolicy: "whenPresent",
  });
  assert.deepEqual(
    responsesCompatibilityProfile(
      "openai",
      "http://127.0.0.1:4000/v1/responses",
    ),
    {
      requestProfile: "standard",
      sequencePolicy: "whenPresent",
    },
  );
});

test("normalizes LiteLLM stream identities and disables response retrieval", async () => {
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.CREWON_RESPONSES_ENDPOINT;
  const originalModel = process.env.CREWON_MODEL_ID;
  const originalStore = process.env.CREWON_RESPONSES_STORE;
  let requestBody: Readonly<Record<string, unknown>> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Readonly<
      Record<string, unknown>
    >;
    return new Response(
      [
        event({
          type: "response.created",
          response: { id: "resp-created" },
        }),
        event({ type: "response.output_text.delta", delta: "gateway output" }),
        event({
          type: "response.completed",
          response: {
            id: "resp-completed",
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "gateway output" }],
              },
            ],
          },
        }),
        "data: [DONE]\n\n",
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  process.env.CREWON_RESPONSES_ENDPOINT =
    "https://gateway.example/v1/responses";
  process.env.CREWON_MODEL_ID = "gateway-model";
  process.env.CREWON_RESPONSES_STORE = "true";

  try {
    const transport = createModelTransport("responses", {
      providerId: "litellm",
    });
    const events = [];
    for await (const value of transport.stream(
      {
        schemaVersion: "crewon.model-request.v0",
        runId: "run-1",
        segmentId: "segment-1",
        agentVersionId: "agent-version-1",
        instructions: null,
        input: {
          strategy: "manual",
          items: [{ type: "message", role: "user", content: "hello" }],
        },
        tools: [],
        maxOutputBytes: 32 * 1024,
      },
      new AbortController().signal,
    )) {
      events.push(value);
    }

    assert.equal(transport.supportsResponseRetrieve, false);
    assert.deepEqual(events, [
      { type: "output.delta", delta: "gateway output" },
      { type: "completed", checkpoint: null },
    ]);
    assert.equal(requestBody?.store, false);
    assert.equal(Object.hasOwn(requestBody!, "reasoning"), false);
    assert.equal(Object.hasOwn(requestBody!, "parallel_tool_calls"), false);
    assert.equal(transport.adapterVersion, "1");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment("CREWON_RESPONSES_ENDPOINT", originalEndpoint);
    restoreEnvironment("CREWON_MODEL_ID", originalModel);
    restoreEnvironment("CREWON_RESPONSES_STORE", originalStore);
  }
});

function event(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("pins an explicit environment output ceiling into the bootstrap AgentVersion", async () => {
  const { compileRuntimeAgentVersion } = await import(
    "./agent-version-release.ts"
  );
  const names = [
    "CREWON_RESPONSES_ENDPOINT",
    "CREWON_MODEL_ID",
    "CREWON_RESPONSES_MAX_OUTPUT_TOKENS",
    "CREWON_RESPONSES_WEBSOCKET_ENABLED",
  ];
  const prior = names.map((name) => process.env[name]);
  try {
    process.env.CREWON_RESPONSES_ENDPOINT =
      "https://api.openai.com/v1/responses";
    process.env.CREWON_MODEL_ID = "fixture-model";
    process.env.CREWON_RESPONSES_WEBSOCKET_ENABLED = "false";
    const compile = () =>
      compileRuntimeAgentVersion({
        runtimeTenantId: "tenant-1",
        transport: createModelTransport("responses"),
        route: {
          agentVersionId: "version-1",
          runtimeGeneration: "ts-v0",
          policySnapshotId: "policy-1",
          authorityId: "authority-1",
          workspaceBindingId: null,
        },
      });
    delete process.env.CREWON_RESPONSES_MAX_OUTPUT_TOKENS;
    const legacy = compile();
    assert.equal(Object.hasOwn(legacy.model, "maxOutputTokens"), false);
    process.env.CREWON_RESPONSES_MAX_OUTPUT_TOKENS = "128";
    const capped = compile();
    assert.equal(capped.model.maxOutputTokens, 128);
    assert.notEqual(capped.contentDigest, legacy.contentDigest);
    process.env.CREWON_RESPONSES_WEBSOCKET_ENABLED = "true";
    const hybrid = createModelTransport("responses");
    assert.equal(hybrid.maxOutputTokens, 128);
    await hybrid.close?.();
    for (const invalid of ["", "0", "-1", "1.5", "NaN", "9007199254740992"]) {
      process.env.CREWON_RESPONSES_MAX_OUTPUT_TOKENS = invalid;
      assert.throws(
        () => createModelTransport("responses"),
        /CREWON_RESPONSES_MAX_OUTPUT_TOKENS_invalid/,
      );
    }
  } finally {
    names.forEach((name, i) => {
      if (prior[i] === undefined) delete process.env[name];
      else process.env[name] = prior[i];
    });
  }
});
