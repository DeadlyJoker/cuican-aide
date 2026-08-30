import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_AGENT_EVENT_TYPES,
  canonicalAgentEventJsonSchema,
  parseCanonicalAgentEvent,
} from "./agent-events.ts";
import { ContractValidationError } from "./contract-validation-error.ts";

const validEvent = {
  schemaVersion: "crewon.agent-event.v0",
  runId: "run-1",
  segmentId: "segment-1",
  sequence: 1,
  type: "segment.started",
  data: { model: "fake-model" },
} as const;

test("schema and TypeScript event names share one source", () => {
  assert.deepEqual(
    canonicalAgentEventJsonSchema.properties.type.enum,
    CANONICAL_AGENT_EVENT_TYPES,
  );
});

test("accepts a bounded canonical event", () => {
  assert.deepEqual(parseCanonicalAgentEvent(validEvent), validEvent);
});

test("rejects unknown fields and unsupported event types", () => {
  assert.throws(
    () => parseCanonicalAgentEvent({ ...validEvent, requestId: "volatile" }),
    (error: unknown) =>
      error instanceof ContractValidationError &&
      error.code === "event_fields_invalid",
  );
  assert.throws(
    () =>
      parseCanonicalAgentEvent({ ...validEvent, type: "sdk.internal.event" }),
    (error: unknown) =>
      error instanceof ContractValidationError &&
      error.code === "event_type_unsupported",
  );
});

test("rejects non-finite or oversized event data", () => {
  assert.throws(
    () =>
      parseCanonicalAgentEvent({ ...validEvent, data: { usage: Number.NaN } }),
    (error: unknown) =>
      error instanceof ContractValidationError &&
      error.code === "event_data_invalid",
  );
  assert.throws(
    () =>
      parseCanonicalAgentEvent(
        { ...validEvent, data: { text: "x".repeat(128) } },
        64,
      ),
    (error: unknown) =>
      error instanceof ContractValidationError &&
      error.code === "event_too_large",
  );
});

test("fails closed on cyclic, non-plain and deeply nested event data", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let deeplyNested: Record<string, unknown> = {};
  for (let depth = 0; depth < 40; depth += 1) {
    deeplyNested = { child: deeplyNested };
  }

  for (const data of [cyclic, { createdAt: new Date(0) }, deeplyNested]) {
    assert.throws(
      () => parseCanonicalAgentEvent({ ...validEvent, data }),
      (error: unknown) =>
        error instanceof ContractValidationError &&
        error.code === "event_data_invalid",
    );
  }
});
