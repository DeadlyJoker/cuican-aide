import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ModelRequest, ModelTransportEvent } from "@crewon/agent-kernel";

import { DirectResponsesTransport } from "./direct-responses-transport.ts";
import {
  MAX_TURN_STATE_BYTES,
  MAX_TURN_STATE_RUNS,
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
  maxRuns: number;
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

  await collect(transport.stream(request(fixture.runs[0]), signal()));
  await collect(transport.stream(request(fixture.runs[0]), signal()));
  await collect(transport.stream(request(fixture.runs[1]), signal()));

  assert.deepEqual(observed, [
    { runId: fixture.runs[0], state: null },
    { runId: fixture.runs[0], state: fixture.state },
    { runId: fixture.runs[1], state: null },
  ]);
});

test("AR-043 fails closed on duplicate, oversized, invalid, and conflicting state", () => {
  assert.equal(MAX_TURN_STATE_BYTES, fixture.maxBytes);
  assert.equal(MAX_TURN_STATE_RUNS, fixture.maxRuns);
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
  authority.observe(fixture.runs[0], [fixture.state]);
  assert.throws(
    () => authority.observe(fixture.runs[0], ["different"]),
    /conflict/u,
  );
  authority.observe(fixture.runs[1], ["different"]);
});

test("AR-043 fails closed instead of retaining unbounded Run state", () => {
  const authority = new ResponsesTurnStateAuthority();
  for (let index = 0; index < MAX_TURN_STATE_RUNS; index += 1) {
    authority.observe(`run-${index}`, [`state-${index}`]);
  }
  assert.throws(
    () => authority.observe("run-over-capacity", ["state-over-capacity"]),
    /capacity_exceeded/u,
  );
  assert.equal(authority.get("run-over-capacity"), null);
});

function request(runId: string): ModelRequest {
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
