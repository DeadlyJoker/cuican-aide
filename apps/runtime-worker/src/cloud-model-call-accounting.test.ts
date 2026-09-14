import assert from "node:assert/strict";
import test from "node:test";
import type { ModelCallObservation } from "@crewon/domain";
import type { ModelRequest, ModelTransportEvent } from "@crewon/agent-kernel";
import { CloudAgentTransport } from "./cloud-agent-transport.ts";

for (const reported of [false, true])
  test(`Cloud Agent ${reported ? "reported" : "missing"} usage stays distinct from its invocation`, async () => {
    const records: ModelCallObservation[] = [];
    const request: ModelRequest = {
      schemaVersion: "crewon.model-request.v0",
      runId: "run",
      segmentId: "segment",
      agentVersionId: "agent",
      instructions: null,
      input: {
        strategy: "manual",
        items: [{ type: "message", role: "user", content: "request" }],
      },
      tools: [],
      maxOutputBytes: 8192,
    };
    const transport = new CloudAgentTransport(
      {
        invocationUrl: "https://cloud.test/invoke",
        apiKey: "test-key",
        model: "cloud-model",
        agentId: 1,
        idleTimeoutMs: 1000,
      },
      {
        fetch: async (_url, init) => {
          assert.equal(records.length, 1);
          assert.equal(records[0]?.outcome, "unknown");
          assert(!String(init?.body).includes("callId"));
          return new Response(
            [
              { event: "message", chunk: "answer" },
              {
                event: "done",
                ...(reported
                  ? {
                      token_usage: {
                        prompt_tokens: 10,
                        completion_tokens: 1,
                        total_tokens: 11,
                      },
                    }
                  : {}),
              },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
    );
    const events: ModelTransportEvent[] = [];
    for await (const event of transport.stream(
      request,
      new AbortController().signal,
      {
        callSink: {
          purpose: "agent",
          record: async (value) => {
            records.push(structuredClone(value));
          },
        },
      },
    ))
      events.push(event);
    assert.equal(records.length, 2);
    assert.equal(records[1]?.transport, "cloudAgent");
    assert.equal(records[1]?.outcome, "completed");
    assert.equal(records[1]?.providerResponseId, null);
    assert.equal(
      events.filter((event) => event.type === "usage").length,
      reported ? 1 : 0,
    );
    if (reported)
      assert.equal(
        events.find((event) => event.type === "usage")?.callId,
        records[0]?.callId,
      );
  });
