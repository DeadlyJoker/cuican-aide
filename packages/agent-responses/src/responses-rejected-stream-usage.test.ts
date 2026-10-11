import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelTransportError,
  modelTransportFailureUsage,
  type ModelRequest,
  type ModelTransportEvent,
} from "@crewon/agent-kernel";
import { DirectResponsesTransport } from "./direct-responses-transport.ts";

const request: ModelRequest = {
  schemaVersion: "crewon.model-request.v0",
  runId: "rejected-usage-run",
  segmentId: "rejected-usage-segment",
  agentVersionId: "rejected-usage-agent",
  instructions: null,
  input: {
    strategy: "manual",
    items: [{ type: "message", role: "user", content: "hello" }],
  },
  tools: [],
  maxOutputBytes: 4096,
};
const usage = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 80 },
  output_tokens: 10,
  total_tokens: 110,
};

for (const status of ["completed", "failed", "incomplete"] as const) {
  for (const flushBytes of [undefined, 1024]) {
    test(`${status} preserves only private validated usage after a rejected tail, flush=${flushBytes}`, async () => {
      const calls: {
        callId: string;
        outcome: string;
        usageEventObserved: boolean;
      }[] = [];
      const transport = openTransport(
        terminalFrames(status) +
          frame({
            type: "response.output_text.delta",
            sequence_number: 3,
            delta: "invalid late output",
          }),
        flushBytes,
      );
      const publicEvents: ModelTransportEvent[] = [];
      let failure: unknown;
      await assert.rejects(async () => {
        try {
          for await (const event of transport.stream(
            request,
            new AbortController().signal,
            {
              callSink: {
                purpose: "agent",
                record: async (observation) => {
                  calls.push(structuredClone(observation));
                },
              },
            },
          ))
            publicEvents.push(event);
        } catch (error) {
          failure = error;
          throw error;
        }
      }, hasCode("responses_event_after_terminal"));
      assert.equal(
        publicEvents.some((event) => event.type !== "output.delta"),
        false,
      );
      assert.equal(calls.length, 2);
      assert.equal(calls[1]?.outcome, "failed");
      assert.equal(calls[1]?.usageEventObserved, true);
      assert.deepEqual(modelTransportFailureUsage(failure), {
        type: "usage",
        callId: calls[0]?.callId,
        providerResponseId: "resp-rejected",
        ...(status === "completed" ? {} : { responseStatus: status }),
        inputTokens: 100,
        cachedInputTokens: 80,
        cachedInputTokensReported: true,
        outputTokens: 10,
        totalTokens: 110,
      });
      assert.equal(JSON.stringify(failure).includes("inputTokens"), false);
    });
  }
}

for (const [name, response, code] of [
  [
    "invalid usage",
    { usage: { ...usage, total_tokens: 999 } },
    "responses_usage_total_mismatch",
  ],
  [
    "response identity conflict",
    { id: "other-response" },
    "responses_response_id_mismatch",
  ],
  [
    "invalid final output",
    {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "other output" }],
        },
      ],
    },
    "responses_output_mismatch",
  ],
] as const) {
  test(`${name} never grants private usage evidence`, async () => {
    let failure: unknown;
    await assert.rejects(async () => {
      try {
        for await (const _ of openTransport(
          terminalFrames("completed", response),
        ).stream(request, new AbortController().signal)) {
          /* drain */
        }
      } catch (error) {
        failure = error;
        throw error;
      }
    }, hasCode(code));
    assert.equal(modelTransportFailureUsage(failure), null);
  });
}

test("malformed received JSON cannot erase prior validated usage or create a completion", async () => {
  const observed: ModelTransportEvent[] = [];
  let failure: unknown;
  await assert.rejects(async () => {
    try {
      for await (const event of openTransport(
        terminalFrames("completed") + "data: not-json\n\n",
      ).stream(request, new AbortController().signal))
        observed.push(event);
    } catch (error) {
      failure = error;
      throw error;
    }
  }, hasCode("responses_event_json_invalid"));
  assert.equal(modelTransportFailureUsage(failure)?.totalTokens, 110);
  assert.deepEqual(
    observed.map((event) => event.type),
    ["output.delta"],
  );
});

test("a normal completion still emits exactly one usage event without failure evidence", async () => {
  const observed: ModelTransportEvent[] = [];
  for await (const event of openTransport(terminalFrames("completed")).stream(
    request,
    new AbortController().signal,
  ))
    observed.push(event);
  assert.deepEqual(
    observed.map((event) => event.type),
    ["output.delta", "usage", "completed"],
  );
  assert.equal(
    modelTransportFailureUsage(
      new ModelTransportError({
        category: "protocol",
        code: "unrelated",
        retryable: false,
      }),
    ),
    null,
  );
});

function terminalFrames(
  status: "completed" | "failed" | "incomplete",
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp-rejected" },
    },
    { type: "response.output_text.delta", sequence_number: 1, delta: "answer" },
    {
      type: `response.${status}`,
      sequence_number: 2,
      response: {
        id: "resp-rejected",
        status,
        usage,
        ...(status === "completed"
          ? {
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "answer" }],
                },
              ],
            }
          : status === "failed"
            ? { error: { code: "invalid_prompt" } }
            : { incomplete_details: { reason: "max_output_tokens" } }),
        ...overrides,
      },
    },
  ]
    .map(frame)
    .join("");
}

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function openTransport(
  body: string,
  flushBytes?: number,
): DirectResponsesTransport {
  return new DirectResponsesTransport(
    {
      endpoint: "https://rejected.example/v1/responses",
      model: "rejected-model",
      ...(flushBytes === undefined
        ? {}
        : { outputDeltaFlushBytes: flushBytes }),
    },
    {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    },
  );
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ModelTransportError &&
    error.code === code &&
    !error.retryable;
}
