import assert from "node:assert/strict";
import test from "node:test";

import type { ModelRequest } from "@crewon/agent-kernel";

import { resolveResponsesRuntimeConfiguration } from "./responses-runtime-configuration.ts";
import { createModelTransport } from "./runtime-process-environment.ts";

const officialEndpoint = "https://api.openai.com/v1/responses";
const gatewayEndpoint = "https://gateway.example/v1/responses";
const request: ModelRequest = {
  schemaVersion: "crewon.model-request.v0",
  runId: "run-profile",
  segmentId: "segment-profile",
  agentVersionId: "agent-profile",
  instructions: null,
  input: {
    strategy: "manual",
    items: [
      { type: "message", role: "user", content: "first" },
      { type: "message", role: "assistant", content: "earlier answer" },
      { type: "message", role: "user", content: "continue" },
    ],
  },
  tools: [
    {
      schemaVersion: "crewon.tool-definition.v0",
      kind: "function",
      name: "read_status",
      description: "Read task status.",
      execution: "serial",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],
  maxOutputBytes: 8192,
};

test("absent request-profile overrides use Standard while preserving official and portable response policies", () => {
  for (const endpoint of [
    officialEndpoint,
    gatewayEndpoint,
    "http://127.0.0.1:4000/v1/responses",
    "https://private.example/tenant/v1/responses",
  ]) {
    const { config, websocket } = resolveResponsesRuntimeConfiguration({
      CREWON_RESPONSES_ENDPOINT: endpoint,
      CREWON_MODEL_ID: "model",
    });
    const official = endpoint === officialEndpoint;
    assert.equal(config.requestProfile, "standard");
    assert.equal(config.sequencePolicy, official ? "required" : "whenPresent");
    assert.equal(
      config.identityPolicy,
      official ? "strict" : "terminalAuthoritative",
    );
    assert.equal(config.storeResponses, false);
    assert.equal(config.idleTimeoutMs, 60000);
    assert.equal(Object.hasOwn(config, "outputDeltaFlushBytes"), false);
    assert.equal(websocket, null);
  }
});

test("explicit profiles change request serialization without changing gateway capabilities", () => {
  for (const profile of ["standard", "responsesLite"] as const) {
    for (const endpoint of [officialEndpoint, gatewayEndpoint]) {
      const { config, websocket } = resolveResponsesRuntimeConfiguration({
        CREWON_RESPONSES_ENDPOINT: endpoint,
        CREWON_MODEL_ID: "model",
        CREWON_RESPONSES_REQUEST_PROFILE: profile,
        CREWON_RESPONSES_STORE: "true",
        CREWON_RESPONSES_SEQUENCE_POLICY: "required",
        CREWON_RESPONSES_WEBSOCKET_ENABLED: "true",
      });
      const official = endpoint === officialEndpoint;
      assert.equal(config.requestProfile, profile);
      assert.equal(config.storeResponses, official);
      assert.equal(
        config.sequencePolicy,
        official ? "required" : "whenPresent",
      );
      assert.equal(
        config.identityPolicy,
        official ? "strict" : "terminalAuthoritative",
      );
      assert.equal(websocket === null, !official);
    }
  }
});

test("invalid explicit profiles fail on gateways as well as official endpoints", () => {
  for (const endpoint of [officialEndpoint, gatewayEndpoint]) {
    for (const profile of ["", "invalid", "STANDARD", " standard "]) {
      assert.throws(
        () =>
          resolveResponsesRuntimeConfiguration({
            CREWON_RESPONSES_ENDPOINT: endpoint,
            CREWON_MODEL_ID: "model",
            CREWON_RESPONSES_REQUEST_PROFILE: profile,
          }),
        /CREWON_RESPONSES_REQUEST_PROFILE_invalid/u,
      );
    }
  }
});

for (const profile of ["default", "standard", "responsesLite"] as const) {
  test(`configured gateway ${profile} reaches the transport as one POST without storage or retrieval`, async () => {
    const originalFetch = globalThis.fetch;
    const methods: string[] = [];
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      methods.push(init?.method ?? "GET");
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-openai-internal-codex-responses-lite"), null);
      return new Response(
        [
          { type: "response.created", response: { id: "created-response" } },
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
              id: "completed-response",
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
    const transport = (() => {
      try {
        return createModelTransport(
          "responses",
          { providerId: "openai" },
          {
            CREWON_RESPONSES_ENDPOINT: gatewayEndpoint,
            CREWON_MODEL_ID: "model",
            ...(profile === "default"
              ? {}
              : { CREWON_RESPONSES_REQUEST_PROFILE: profile }),
            CREWON_RESPONSES_STORE: "true",
            CREWON_RESPONSES_WEBSOCKET_ENABLED: "true",
          },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    })();
    try {
      assert.equal(
        transport.adapterVersion,
        profile === "responsesLite" ? "1+responses-lite" : "1",
      );
      assert.equal(transport.supportsResponseRetrieve, false);
      const events = [];
      for await (const event of transport.stream(
        request,
        new AbortController().signal,
      ))
        events.push(event);
      assert.deepEqual(events, [
        { type: "output.delta", delta: "answer" },
        {
          type: "output.item.completed",
          item: { type: "message", role: "assistant", content: "answer" },
        },
        { type: "completed", checkpoint: null },
      ]);
      assert.deepEqual(methods, ["POST"]);
      assert.ok(body);
      assert.equal(body.store, false);
      assert.equal(Object.hasOwn(body, "previous_response_id"), false);
      assert.deepEqual(body.input, [
        { role: "user", content: "first" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "continue" },
      ]);
      assert.deepEqual(body.tools, [
        {
          type: "function",
          name: "read_status",
          description: "Read task status.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ]);
      assert.equal(
        Object.hasOwn(body, "reasoning"),
        profile === "responsesLite",
      );
      assert.equal(
        Object.hasOwn(body, "parallel_tool_calls"),
        profile === "responsesLite",
      );
      if (profile === "responsesLite") {
        assert.deepEqual(body.reasoning, { context: "all_turns" });
        assert.equal(body.parallel_tool_calls, false);
      }
    } finally {
      await transport.close?.();
    }
  });
}
