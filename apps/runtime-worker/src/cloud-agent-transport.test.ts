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
    redirect: RequestRedirect | undefined;
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
      redirect: init?.redirect,
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
    redirect: "error",
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
        retryable: false,
      },
    );
    return true;
  });
});

test("rejects non-SSE success responses before parsing a cloud Agent body", async () => {
  let fetchCalls = 0;
  const transport = cloudTransport(async () => {
    fetchCalls += 1;
    return new Response('{"event":"done"}', {
      headers: { "content-type": "application/json" },
    });
  });

  await assert.rejects(
    collect(transport, request()),
    hasTransportCode("cloud_agent_stream_content_type_invalid", "protocol"),
  );
  assert.equal(fetchCalls, 1);
});

test("treats an ambiguous cloud Agent stream failure as non-retryable", async () => {
  let fetchCalls = 0;
  const transport = cloudTransport(async () => {
    fetchCalls += 1;
    return new Response(sse({ event: "message", chunk: "partial" }), {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  });

  await assert.rejects(
    collect(transport, request()),
    hasTransportCode("cloud_agent_stream_incomplete", "incomplete"),
  );
  assert.equal(fetchCalls, 1);
});

test("rejects events after the cloud Agent terminal", async () => {
  const transport = cloudTransport(
    async () =>
      new Response(
        [
          sse({ event: "done" }),
          sse({ event: "message", chunk: "late output" }),
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );

  await assert.rejects(
    collect(transport, request()),
    hasTransportCode("cloud_agent_event_after_done", "protocol"),
  );
});

test("rejects an SSE envelope terminator before the cloud Agent terminal", async () => {
  const transport = cloudTransport(
    async () =>
      new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
  );

  await assert.rejects(
    collect(transport, request()),
    hasTransportCode("cloud_agent_stream_incomplete", "incomplete"),
  );
});

test("rejects unsafe invocation URLs and invalid numeric bindings", () => {
  for (const config of [
    { invocationUrl: "http://agents.example/invoke", agentId: 1 },
    { invocationUrl: "https://agents.example/invoke", agentId: 0 },
    { invocationUrl: "https://agents.example/invoke", agentId: Number.NaN },
  ]) {
    assert.throws(
      () =>
        new CloudAgentTransport({
          ...config,
          apiKey: "cloud-key",
          model: "cloud-model",
          idleTimeoutMs: 60_000,
        }),
      /cloud_agent_(?:invocation_url|id)_invalid/u,
    );
  }
});

test("allows HTTP only for IPv6 loopback hosts", () => {
  assert.doesNotThrow(
    () =>
      new CloudAgentTransport({
        invocationUrl: "http://[::1]:3210/invoke",
        apiKey: "cloud-key",
        model: "cloud-model",
        agentId: 42,
        idleTimeoutMs: 60_000,
      }),
  );

  for (const invocationUrl of [
    "http://[::2]:3210/invoke",
    "http://[2001:db8::1]:3210/invoke",
    "http://192.168.1.10:3210/invoke",
  ]) {
    assert.throws(
      () =>
        new CloudAgentTransport({
          invocationUrl,
          apiKey: "cloud-key",
          model: "cloud-model",
          agentId: 42,
          idleTimeoutMs: 60_000,
        }),
      /cloud_agent_invocation_url_invalid/u,
    );
  }
});

test("rejects CrewON-owned request controls before invoking a cloud Agent", async () => {
  for (const [expectedCode, override] of [
    [
      "cloud_agent_instructions_unsupported",
      { instructions: "Use the local prompt." },
    ],
    [
      "cloud_agent_tools_unsupported",
      {
        tools: [
          {
            schemaVersion: "crewon.tool-definition.v0" as const,
            kind: "function" as const,
            name: "local_tool",
            description: "Must not be silently discarded.",
            execution: "serial" as const,
            inputSchema: { type: "object", additionalProperties: false },
          },
        ],
      },
    ],
    ["cloud_agent_turn_state_unsupported", { providerTurnState: "state" }],
  ] as const) {
    let fetchCalls = 0;
    const transport = cloudTransport(async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    });

    await assert.rejects(
      collect(transport, { ...request(), ...override }),
      hasTransportCode(expectedCode),
    );
    assert.equal(fetchCalls, 0);
  }
});

test("rejects unsupported or trailing cloud Agent history before fetch", async () => {
  for (const items of [
    [
      { type: "message", role: "developer", content: "trusted prefix" },
      { type: "message", role: "user", content: "current task" },
    ],
    [
      { type: "message", role: "system", content: "system prefix" },
      { type: "message", role: "user", content: "current task" },
    ],
    [
      { type: "message", role: "user", content: "previous task" },
      {
        type: "tool_call",
        kind: "function",
        callId: "call-1",
        name: "lookup",
        input: "{}",
      },
      { type: "message", role: "user", content: "current task" },
    ],
    [
      {
        type: "tool_result",
        kind: "function",
        callId: "call-1",
        output: "result",
      },
      { type: "message", role: "user", content: "current task" },
    ],
  ] as const) {
    let fetchCalls = 0;
    const transport = cloudTransport(async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    });
    const input = request();

    await assert.rejects(
      collect(transport, {
        ...input,
        input: { strategy: "manual", items },
      }),
      hasTransportCode("cloud_agent_history_item_unsupported"),
    );
    assert.equal(fetchCalls, 0);
  }

  let fetchCalls = 0;
  const transport = cloudTransport(async () => {
    fetchCalls += 1;
    throw new Error("must not fetch");
  });
  const input = request();
  await assert.rejects(
    collect(transport, {
      ...input,
      input: {
        strategy: "manual",
        items: [
          { type: "message", role: "user", content: "current task" },
          { type: "message", role: "assistant", content: "trailing answer" },
        ],
      },
    }),
    hasTransportCode("cloud_agent_current_message_invalid"),
  );
  assert.equal(fetchCalls, 0);
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
    { fetch },
  );
}

function hasTransportCode(
  code: string,
  category: ModelTransportError["category"] = "invalidRequest",
): (error: unknown) => boolean {
  return (error) =>
    error instanceof ModelTransportError &&
    error.category === category &&
    error.code === code &&
    !error.retryable;
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
