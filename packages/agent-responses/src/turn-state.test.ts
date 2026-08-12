import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ModelRequest, ModelTransportEvent } from "@crewon/agent-kernel";

import { DirectResponsesTransport } from "./direct-responses-transport.ts";
import {
  MAX_TURN_STATE_BYTES,
  ResponsesTurnStateAuthority,
  parseTurnStateHeader,
} from "./turn-state.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/provider-turn-state.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Readonly<{
  header: string;
  maxBytes: number;
  state: string;
  runs: readonly [string, string];
}>;

test("AR-043 keeps opaque response state within one Run and clears it for another", async () => {
  const observed: Array<Readonly<{ runId: string; state: string | null }>> = [];
  let responseCount = 0;
  const transport = new DirectResponsesTransport(
    { endpoint: "https://provider.example/v1/responses", model: "model" },
    {
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { metadata?: unknown };
        const runId = responseCount < 2 ? fixture.runs[0] : fixture.runs[1];
        observed.push({
          runId,
          state: new Headers(init?.headers).get(fixture.header),
        });
        const headers = new Headers({ "content-type": "text/event-stream" });
        if (responseCount++ === 0) headers.set(fixture.header, fixture.state);
        assert.equal(body.metadata, undefined);
        return response(headers);
      },
    },
  );

  const first = await collect(
    transport.stream(request(fixture.runs[0]), signal()),
  );
  const terminal = first.at(-1);
  assert.equal(terminal?.type, "completed");
  assert.equal(
    terminal?.type === "completed" ? terminal.providerTurnState : null,
    fixture.state,
  );
  await collect(
    transport.stream(request(fixture.runs[0], fixture.state), signal()),
  );
  await collect(transport.stream(request(fixture.runs[1]), signal()));

  assert.deepEqual(observed, [
    { runId: fixture.runs[0], state: null },
    { runId: fixture.runs[0], state: fixture.state },
    { runId: fixture.runs[1], state: null },
  ]);
  transport.releaseRun(fixture.runs[0]);
});

test("AR-043 retains observed HTTP state across a failed stream retry", async () => {
  const sent: Array<string | null> = [];
  const persisted: string[] = [];
  let calls = 0;
  const transport = new DirectResponsesTransport(
    { endpoint: "https://provider.example/v1/responses", model: "model" },
    {
      fetch: async (_url, init) => {
        sent.push(new Headers(init?.headers).get(fixture.header));
        const headers = new Headers({ "content-type": "text/event-stream" });
        if (calls++ === 0) {
          headers.set(fixture.header, fixture.state);
          return new Response("data: not-json\n\n", { headers });
        }
        return response(headers);
      },
    },
  );

  await assert.rejects(
    collect(
      transport.stream(request(fixture.runs[0]), signal(), {
        controlSink: {
          providerTurnStateObserved: async (providerTurnState) => {
            persisted.push(providerTurnState);
          },
        },
      }),
    ),
  );
  await collect(
    transport.stream(request(fixture.runs[0]), signal(), {
      controlSink: {
        providerTurnStateObserved: async (providerTurnState) => {
          persisted.push(providerTurnState);
        },
      },
    }),
  );
  await collect(transport.stream(request(fixture.runs[1]), signal()));
  assert.deepEqual(sent, [null, fixture.state, null]);
  assert.deepEqual(persisted, [fixture.state]);
  transport.releaseRun(fixture.runs[0]);
});

test("AR-043 blocks HTTP body events until observed state is durable", async () => {
  let sinkCalls = 0;
  const sinkFailure = new Error("durable_write_failed");
  const transport = new DirectResponsesTransport(
    { endpoint: "https://provider.example/v1/responses", model: "model" },
    {
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
              controller.close();
            },
          }),
          {
            headers: {
              "content-type": "text/event-stream",
              [fixture.header]: fixture.state,
            },
          },
        ),
    },
  );

  await assert.rejects(
    collect(
      transport.stream(request(fixture.runs[0]), signal(), {
        controlSink: {
          providerTurnStateObserved: async () => {
            sinkCalls += 1;
            throw sinkFailure;
          },
        },
      }),
    ),
    (error) => error === sinkFailure,
  );
  await assert.rejects(
    collect(
      transport.stream(request(fixture.runs[0]), signal(), {
        controlSink: {
          providerTurnStateObserved: async () => {
            sinkCalls += 1;
          },
        },
      }),
    ),
  );
  assert.equal(sinkCalls, 2);
});

test("AR-043 fails closed on duplicate, oversized, invalid, and conflicting state", async () => {
  assert.equal(MAX_TURN_STATE_BYTES, fixture.maxBytes);
  assert.throws(() => parseTurnStateHeader(["a", "a"]), /duplicate/u);
  assert.throws(
    () => parseTurnStateHeader(["x".repeat(fixture.maxBytes + 1)]),
    /invalid/u,
  );
  assert.throws(() => parseTurnStateHeader(["bad\nvalue"]), /invalid/u);
  assert.throws(() => parseTurnStateHeader(["状态"]), /invalid/u);
  assert.throws(
    () => parseTurnStateHeader(["merged-first, merged-second"]),
    /invalid/u,
  );
  const authority = new ResponsesTurnStateAuthority();
  await authority.observe(fixture.runs[0], [fixture.state]);
  await assert.rejects(
    authority.observe(fixture.runs[0], ["different"]),
    /conflict/u,
  );
  await authority.observe(fixture.runs[1], ["different"]);
  assert.throws(
    () => authority.seed(fixture.runs[0], "different"),
    /conflict/u,
  );
});

test("AR-043 releases terminal transport state instead of imposing a Run cap", async () => {
  const authority = new ResponsesTurnStateAuthority();
  for (let index = 0; index < 1_000; index += 1) {
    await authority.observe(`run-${index}`, [`state-${index}`]);
    authority.release(`run-${index}`);
  }
  await authority.observe("run-after-terminals", ["state-after-terminals"]);
  assert.equal(authority.get("run-after-terminals"), "state-after-terminals");
});

function request(
  runId: string,
  providerTurnState: string | null = null,
): ModelRequest {
  return {
    schemaVersion: "crewon.model-request.v0",
    runId,
    segmentId: `segment-${runId}`,
    agentVersionId: "agent-version",
    instructions: null,
    input: {
      strategy: "manual",
      items: [{ type: "message", role: "user", content: "hello" }],
    },
    tools: [],
    maxOutputBytes: 1024,
    ...(providerTurnState === null ? {} : { providerTurnState }),
  };
}

function response(headers: Headers): Response {
  const events = [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: "response-id" },
    },
    {
      type: "response.completed",
      sequence_number: 1,
      response: {
        id: "response-id",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
      },
    },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers },
  );
}

async function collect(
  iterable: AsyncIterable<ModelTransportEvent>,
): Promise<ModelTransportEvent[]> {
  const events: ModelTransportEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
