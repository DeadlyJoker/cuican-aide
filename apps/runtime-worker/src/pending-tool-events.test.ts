import assert from "node:assert/strict";
import test from "node:test";
import { loadPendingToolEventsForSegment } from "./pending-tool-events.ts";

test("isolates ordered pending tools to one Workflow sibling segment", async () => {
  const requested = (sequence: number, segmentId: string, callId: string) => ({
    schemaVersion: "crewon.run-event.v0" as const,
    identity: { runId: "run-1" },
    eventId: `event-${sequence}`,
    sequence,
    occurredAt: "2026-08-14T00:00:00.000Z",
    type: "tool.requested" as const,
    data: {
      segmentId,
      segmentSequence: sequence,
      callId,
      kind: "function" as const,
      name: "tool",
      input: "{}",
    },
  });
  const events = [
    requested(1, "segment-a", "a-1"),
    requested(2, "segment-b", "b-1"),
    requested(3, "segment-a", "a-2"),
    {
      schemaVersion: "crewon.run-event.v0" as const,
      identity: { runId: "run-1" },
      eventId: "event-4",
      sequence: 4,
      occurredAt: "2026-08-14T00:00:00.000Z",
      type: "tool.completed" as const,
      data: {
        segmentId: "segment-a",
        segmentSequence: 4,
        callId: "a-1",
        kind: "function" as const,
        name: "tool",
        output: "done",
        isError: false,
        artifactRef: null,
        outputTruncated: false,
      },
    },
  ];
  const result = await loadPendingToolEventsForSegment({
    store: {
      async listRunEvents(_locator: unknown, after: number) {
        return events.filter((event) => event.sequence > after);
      },
    } as never,
    run: { tenantId: "tenant-1", runId: "run-1", lastSequence: 4 } as never,
    segmentId: "segment-a",
  });
  assert.deepEqual(
    result.events.map((event) => event.data.callId),
    ["a-2"],
  );
  assert.deepEqual(result.requestedCallIds, ["a-1", "a-2"]);
  assert.deepEqual(result.completedCallIds, ["a-1"]);
  assert.equal(result.lastSegmentSequence, 4);
});
