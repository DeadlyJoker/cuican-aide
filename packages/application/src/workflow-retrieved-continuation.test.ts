import assert from "node:assert/strict";
import test from "node:test";

import { validateWorkflowRetrievedContinuationPayload } from "./workflow-retrieved-continuation.ts";

const next = {
  schemaVersion: "crewon.workflow-node-continuation.v0",
  segmentId: "segment-1",
  modelSampleIndex: 0,
  toolRoundsConsumed: 0,
  providerCheckpoint: null,
  providerTurnState: null,
  history: [],
} as const;

test("accepts a bounded tool-only retrieved continuation", () => {
  const input = {
    events: [
      {
        schemaVersion: "crewon.agent-event.v0",
        runId: "run-1",
        segmentId: "segment-1",
        sequence: 2,
        type: "tool.requested",
        data: {
          callId: "call-1",
          kind: "function",
          name: "lookup",
          input: "{}",
        },
      },
    ],
    assistantContinuation: null,
    next,
  } as const;

  assert.deepEqual(validateWorkflowRetrievedContinuationPayload(input), input);
});

test("rejects a nonterminal payload without assistant or Tool authority", () => {
  assert.throws(
    () =>
      validateWorkflowRetrievedContinuationPayload({
        events: [],
        assistantContinuation: null,
        next,
      }),
    /workflow_retrieved_continuation_invalid/,
  );
});

test("rejects caller authority fields and oversized event bundles", () => {
  assert.throws(
    () =>
      validateWorkflowRetrievedContinuationPayload({
        events: [],
        assistantContinuation: null,
        next: { ...next, authority: { tenantId: "forged" } },
      }),
    /workflow_retrieved_continuation_invalid/,
  );
  assert.throws(
    () =>
      validateWorkflowRetrievedContinuationPayload({
        events: Array.from({ length: 65 }, (_, index) => ({
          schemaVersion: "crewon.agent-event.v0",
          runId: "run-1",
          segmentId: "segment-1",
          sequence: index + 1,
          type: "tool.requested",
          data: {
            callId: `call-${index}`,
            kind: "function",
            name: "lookup",
            input: "{}",
          },
        })),
        assistantContinuation: null,
        next,
      }),
    /workflow_retrieved_continuation_invalid/,
  );
});
