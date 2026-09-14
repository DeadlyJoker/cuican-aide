import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalAgentEvent } from "@crewon/contracts";

import { mapAgentEvent } from "./run-execution-support.ts";

test("preserves reported zero, missing and legacy cache metadata in durable usage", () => {
  for (const reported of [true, false, undefined]) {
    const data = {
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 2,
      totalTokens: 12,
      ...(reported === undefined
        ? {}
        : { cachedInputTokensReported: reported }),
    };
    const mapped = mapAgentEvent(
      {
        schemaVersion: "crewon.agent-event.v0",
        runId: "run-1",
        segmentId: "segment-1",
        sequence: 1,
        type: "usage.recorded",
        data,
      },
      2,
      "event-2",
      "2026-09-10T00:00:00Z",
      () => "unused",
    );
    assert.equal(mapped.type, "usage.recorded");
    if (mapped.type !== "usage.recorded") assert.fail();
    assert.deepEqual(mapped.data, {
      segmentId: "segment-1",
      segmentSequence: 1,
      ...data,
    });
  }
});

test("maps a canonical transport fallback into durable Run audit data", () => {
  const event: CanonicalAgentEvent = {
    schemaVersion: "crewon.agent-event.v0",
    runId: "run-1",
    segmentId: "segment-1",
    sequence: 3,
    type: "model.transport.fallback",
    data: {
      fromTransport: "websocket",
      toTransport: "http",
      code: "responses_websocket_closed",
      discardedOutput: true,
    },
  };

  assert.deepEqual(
    mapAgentEvent(event, 7, "event-7", "2026-08-08T00:00:07Z", () =>
      assert.fail("fallback does not contain a provider checkpoint"),
    ),
    {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: "run-1" },
      eventId: "event-7",
      sequence: 7,
      occurredAt: "2026-08-08T00:00:07Z",
      type: "model.transport.fallback",
      data: {
        segmentId: "segment-1",
        segmentSequence: 3,
        fromTransport: "websocket",
        toTransport: "http",
        code: "responses_websocket_closed",
        discardedOutput: true,
      },
    },
  );
});
