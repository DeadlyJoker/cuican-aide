import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  compareTraces,
  stabilizeTrace,
  type CanonicalTrace,
} from "./canonical-trace.ts";

const referenceTrace = JSON.parse(
  readFileSync(
    new URL("../fixtures/text-run.reference.json", import.meta.url),
    "utf8",
  ),
) as CanonicalTrace;

function trace(overrides: Partial<CanonicalTrace> = {}): CanonicalTrace {
  return {
    schemaVersion: "crewon.trace.v0",
    caseId: "text-run",
    events: [
      {
        schemaVersion: "crewon.agent-event.v0",
        sequence: 1,
        type: "segment.started",
        identity: { runId: "run-1", segmentId: "segment-1" },
        eventId: "event-volatile",
        occurredAt: "2026-08-08T00:00:01Z",
        data: { model: "fake", attempt: 1 },
      },
      {
        schemaVersion: "crewon.agent-event.v0",
        sequence: 2,
        type: "segment.completed",
        identity: { runId: "run-1", segmentId: "segment-1" },
        requestId: "request-volatile",
        traceId: "trace-volatile",
        data: { output: "done" },
      },
    ],
    finalState: { status: "completed", revision: 2 },
    ...overrides,
  };
}

test("ignores only explicitly volatile envelope fields", () => {
  const expected = trace();
  const actual = trace({
    events: [
      {
        ...expected.events[0],
        eventId: "another-event",
        occurredAt: "2030-01-01T00:00:00Z",
      },
      {
        ...expected.events[1],
        requestId: "another-request",
        traceId: "another-trace",
      },
    ],
  });
  assert.deepEqual(compareTraces(expected, actual), { equal: true });
});

test("loads the shared deterministic text-run reference fixture", () => {
  const candidate: CanonicalTrace = {
    ...referenceTrace,
    events: referenceTrace.events.map((event, index) => ({
      ...event,
      eventId: `candidate-event-${index + 1}`,
      occurredAt: `2030-01-01T00:00:0${index + 1}Z`,
    })),
  };

  assert.deepEqual(compareTraces(referenceTrace, candidate), { equal: true });
});

test("reports a stable diff for semantic changes", () => {
  const expected = trace();
  const actual = trace({
    events: [
      expected.events[0],
      { ...expected.events[1], data: { output: "changed" } },
    ],
  });
  const comparison = compareTraces(expected, actual);

  assert.equal(comparison.equal, false);
  if (!comparison.equal) {
    assert.match(comparison.expected, /"output": "done"/);
    assert.match(comparison.actual, /"output": "changed"/);
  }
});

test("treats run and segment identity as semantic", () => {
  const expected = trace();
  const actual = trace({
    events: [
      expected.events[0],
      {
        ...expected.events[1],
        identity: { runId: "run-2", segmentId: "segment-1" },
      },
    ],
  });

  const comparison = compareTraces(expected, actual);
  assert.equal(comparison.equal, false);
  if (!comparison.equal) {
    assert.match(comparison.expected, /"runId": "run-1"/);
    assert.match(comparison.actual, /"runId": "run-2"/);
  }
});

test("sorts object keys without reordering events", () => {
  const stable = stabilizeTrace(
    trace({ finalState: { z: 1, a: { y: true, b: false } } }),
  );
  assert.deepEqual(Object.keys(stable.finalState), ["a", "z"]);
  assert.deepEqual(Object.keys(stable.finalState.a as object), ["b", "y"]);
  assert.deepEqual(
    stable.events.map((event) => event.sequence),
    [1, 2],
  );
});

test("fails closed on sequence gaps and non-JSON values", () => {
  assert.throws(
    () =>
      stabilizeTrace(
        trace({ events: [{ ...trace().events[0], sequence: 2 }] }),
      ),
    /trace_sequence_gap/,
  );
  assert.throws(
    () => stabilizeTrace(trace({ finalState: { usage: Number.NaN } })),
    /trace_number_invalid/,
  );
});
