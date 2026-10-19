import assert from "node:assert/strict";
import test from "node:test";
import {
  CrewONAgentKernel,
  type ModelRequest,
  type ModelTransportEvent,
} from "@crewon/agent-kernel";
import type { ProviderCheckpoint } from "@crewon/contracts";
import { DirectResponsesTransport } from "./direct-responses-transport.ts";

const endpoint = "https://provider.test/v1/responses";
const request = {
  schemaVersion: "crewon.model-request.v0",
  runId: "run-a",
  segmentId: "segment-a",
  agentVersionId: "agent",
  instructions: null,
  input: {
    strategy: "manual",
    items: [{ type: "message", role: "user", content: "hello" }],
  },
  tools: [],
  maxOutputBytes: 8192,
} satisfies ModelRequest;

function checkpoint(responseId: string): ProviderCheckpoint {
  return {
    schemaVersion: "crewon.provider-checkpoint.v0",
    adapterName: "direct-responses",
    adapterVersion: "1",
    modelId: "model",
    opaquePayload: { responseId },
  };
}

function completed(responseId: string) {
  return {
    id: responseId,
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "recovered" }],
      },
    ],
  };
}

async function collect(events: AsyncIterable<ModelTransportEvent>) {
  const result = [];
  for await (const event of events) result.push(event);
  return result;
}

test("an interrupted generation retrieves its response on the same verified Run route without a second POST", async () => {
  const methods: string[] = [];
  let durableRouteObserved = false;
  const transport = new DirectResponsesTransport(
    { endpoint, model: "model", storeResponses: true },
    {
      fetch: async (_url, init) => {
        methods.push(init?.method ?? "GET");
        if (init?.method === "POST") {
          return new Response(
            [
              {
                type: "response.created",
                sequence_number: 0,
                response: { id: "response-a" },
              },
              {
                type: "response.output_text.delta",
                sequence_number: 1,
                delta: "partial",
              },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            {
              headers: {
                "content-type": "text/event-stream",
                "x-codex-turn-state": "route-a",
              },
            },
          );
        }
        assert.equal(durableRouteObserved, true);
        if (new Headers(init?.headers).get("x-codex-turn-state") !== "route-a")
          return Response.json(
            { error: { code: "not_found" } },
            { status: 404 },
          );
        return Response.json(completed("response-a"));
      },
    },
  );
  const events = [];
  for await (const event of new CrewONAgentKernel({
    transport,
    retryScheduler: { wait: async () => {} },
  }).runSegment(
    {
      schemaVersion: "crewon.agent-segment.v0",
      purpose: "agent",
      runId: request.runId,
      segmentId: request.segmentId,
      attempt: 1,
      agentVersionId: request.agentVersionId,
      policySnapshotId: "policy",
      collaborationMode: "default",
      allowedTools: null,
      history: request.input.items,
      continuation: { kind: "manual" },
      budget: { maxOutputBytes: request.maxOutputBytes },
    },
    new AbortController().signal,
    {
      controlSink: {
        providerTurnStateObserved: async (route) => {
          assert.equal(route, "route-a");
          durableRouteObserved = true;
        },
      },
    },
  ))
    events.push(event);
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.equal(events.at(-1)?.type, "segment.completed");
  assert.deepEqual(events.at(-1)?.data, {
    output: "recovered",
    providerTurnState: "route-a",
  });
  assert.equal(
    events.filter((event) => event.type === "model.sampling.retry").length,
    1,
  );
});

test("parallel retrieval routes remain Run-local and a released Run cannot inherit another route", async () => {
  const seen = new Map<string, string | null>();
  const transport = new DirectResponsesTransport(
    { endpoint, model: "model", storeResponses: true },
    {
      fetch: async (url, init) => {
        const responseId = new URL(String(url)).pathname.split("/").at(-1)!;
        seen.set(
          responseId,
          new Headers(init?.headers).get("x-codex-turn-state"),
        );
        return Response.json(completed(responseId));
      },
    },
  );
  await Promise.all(
    ["a", "b"].map((suffix) =>
      collect(
        transport.stream(
          {
            ...request,
            runId: `run-${suffix}`,
            providerTurnState: `route-${suffix}`,
            reconcileCheckpoint: checkpoint(`response-${suffix}`),
          },
          new AbortController().signal,
        ),
      ),
    ),
  );
  assert.equal(seen.get("response-a"), "route-a");
  assert.equal(seen.get("response-b"), "route-b");
  transport.releaseRun("run-a");
  await collect(
    transport.stream(
      { ...request, reconcileCheckpoint: checkpoint("response-new") },
      new AbortController().signal,
    ),
  );
  assert.equal(seen.get("response-new"), null);
});

test("routed retrieval preserves response identity validation", async () => {
  const transport = new DirectResponsesTransport(
    { endpoint, model: "model", storeResponses: true },
    {
      fetch: async () => Response.json(completed("different-response")),
    },
  );
  await assert.rejects(
    collect(
      transport.stream(
        {
          ...request,
          providerTurnState: "route-a",
          reconcileCheckpoint: checkpoint("response-a"),
        },
        new AbortController().signal,
      ),
    ),
    { code: "responses_response_id_mismatch", retryable: false },
  );
});

for (const scenario of [
  "storage-disabled",
  "canceled",
  "invalid-route",
] as const)
  test(`routed retrieval never dispatches when ${scenario}`, async () => {
    let dispatched = 0;
    const controller = new AbortController();
    if (scenario === "canceled") controller.abort("test-cancel");
    const transport = new DirectResponsesTransport(
      {
        endpoint,
        model: "model",
        storeResponses: scenario !== "storage-disabled",
      },
      {
        fetch: async () => {
          dispatched += 1;
          return Response.json(completed("response-a"));
        },
      },
    );
    const expected =
      scenario === "storage-disabled"
        ? "responses_retrieve_requires_storage"
        : scenario === "invalid-route"
          ? "responses_turn_state_invalid"
          : "segment_canceled";
    await assert.rejects(
      collect(
        transport.stream(
          {
            ...request,
            providerTurnState:
              scenario === "invalid-route" ? "route\ninvalid" : "route-a",
            reconcileCheckpoint: checkpoint("response-a"),
          },
          controller.signal,
          { callSink: { purpose: "agent", record: async () => {} } },
        ),
      ),
      { code: expected, retryable: false },
    );
    assert.equal(dispatched, 0);
  });
