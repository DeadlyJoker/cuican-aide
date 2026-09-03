import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelTransportError,
  type ModelRequest,
  type ModelTransportEvent,
} from "@crewon/agent-kernel";

import {
  CloudAgentTransport,
  type CloudAgentFetch,
} from "./cloud-agent-transport.ts";

test("projects bounded history and normalizes cloud Agent streaming events", async () => {
  let captured: Readonly<{
    body: unknown;
    headers: Readonly<Record<string, string | null>>;
    method: string | undefined;
    url: string;
  }> | null = null;
  const fetch: CloudAgentFetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    captured = {
      body: JSON.parse(String(init?.body)),
      headers: {
        accept: headers.get("accept"),
        apiKey: headers.get("x-api-key"),
        contentType: headers.get("content-type"),
      },
      method: init?.method,
      url: String(input),
    };
    return new Response(
      [
        sse({ event: "message", chunk: "CLOUD_" }),
        sse({ event: "message", chunk: "AGENT_OK" }),
        sse({
          event: "done",
          token_usage: {
            prompt_tokens: 11,
            completion_tokens: 3,
            total_tokens: 14,
          },
        }),
        "data: [DONE]\n\n",
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const transport = cloudTransport(fetch);

  assert.deepEqual(await collect(transport, request()), [
    { type: "output.delta", delta: "CLOUD_" },
    { type: "output.delta", delta: "AGENT_OK" },
    { type: "usage", inputTokens: 11, outputTokens: 3, totalTokens: 14 },
    { type: "completed", checkpoint: null },
  ]);
  assert.deepEqual(captured, {
    body: {
      message: "current task",
      history: [
        { role: "user", content: "previous task" },
        { role: "assistant", content: "previous answer" },
      ],
    },
    headers: {
      accept: "text/event-stream",
      apiKey: "cloud-key",
      contentType: "application/json",
    },
    method: "POST",
    url: "https://agents.example/invoke",
  });
  assert.equal(transport.supportsResponseRetrieve, false);
});

test("maps cloud Agent HTTP failures without exposing response content", async () => {
  const transport = cloudTransport(
    async () =>
      new Response("secret provider body", {
        status: 429,
        headers: { "retry-after": "1.25" },
      }),
  );

  await assert.rejects(collect(transport, request()), (error: unknown) => {
    assert.ok(error instanceof ModelTransportError);
    assert.deepEqual(
      {
        category: error.category,
        code: error.code,
        message: error.message,
        retryAfterMs: error.retryAfterMs,
        retryable: error.retryable,
      },
      {
        category: "rateLimit",
        code: "cloud_agent_rate_limited",
        message: "cloud_agent_rate_limited",
        retryAfterMs: 1_250,
        retryable: true,
      },
    );
    return true;
  });
});

test("rejects unsafe invocation URLs and invalid numeric bindings", () => {
  for (const config of [
    { invocationUrl: "http://agents.example/invoke", agentId: 1 },
    { invocationUrl: "https://agents.example/invoke", agentId: 0 },
    { invocationUrl: "https://agents.example/invoke", agentId: Number.NaN },
  ]) {
    assert.throws(
      () =>
        new CloudAgentTransport(
          {
            ...config,
            apiKey: "cloud-key",
            model: "cloud-model",
            idleTimeoutMs: 60_000,
          },
          {
            identity: {
              adapterName: "cloud-agent",
              adapterVersion: "1",
            },
          },
        ),
      /cloud_agent_(?:invocation_url|id)_invalid/u,
    );
  }
});

function cloudTransport(fetch: CloudAgentFetch): CloudAgentTransport {
  return new CloudAgentTransport(
    {
      invocationUrl: "https://agents.example/invoke",
      apiKey: "cloud-key",
      model: "cloud-model",
      agentId: 42,
      idleTimeoutMs: 60_000,
    },
    {
      fetch,
      identity: {
        adapterName: "cloud-agent",
        adapterVersion: "1",
      },
    },
  );
}

function request(): ModelRequest {
  return {
    schemaVersion: "crewon.model-request.v0",
    runId: "run-1",
    segmentId: "segment-1",
    agentVersionId: "agent-version-1",
    instructions: null,
    input: {
      strategy: "manual",
      items: [
        { type: "message", role: "user", content: "previous task" },
        { type: "message", role: "assistant", content: "previous answer" },
        { type: "message", role: "user", content: "current task" },
      ],
    },
    tools: [],
    maxOutputBytes: 32 * 1024,
  };
}

async function collect(
  transport: CloudAgentTransport,
  input: ModelRequest,
): Promise<ModelTransportEvent[]> {
  const events: ModelTransportEvent[] = [];
  for await (const event of transport.stream(
    input,
    new AbortController().signal,
  )) {
    events.push(event);
  }
  return events;
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}
