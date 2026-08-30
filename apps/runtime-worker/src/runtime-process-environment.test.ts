import assert from "node:assert/strict";
import test from "node:test";

import {
  createModelTransport,
  responsesCompatibilityProfile,
} from "./runtime-process-environment.ts";

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
    requestProfile: "responsesLite",
    sequencePolicy: "whenPresent",
  });
  assert.deepEqual(responsesCompatibilityProfile("private-gateway"), {
    requestProfile: "responsesLite",
    sequencePolicy: "whenPresent",
  });
  assert.deepEqual(
    responsesCompatibilityProfile(
      "openai",
      "http://127.0.0.1:4000/v1/responses",
    ),
    {
      requestProfile: "responsesLite",
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
