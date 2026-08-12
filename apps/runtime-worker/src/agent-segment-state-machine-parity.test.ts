import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { KernelAgentEvent } from "@crewon/agent-kernel";
import { AgentSegmentStateMachine } from "./agent-segment-state-machine.ts";

test("matches the provider-neutral shared segment reduction trace", async () => {
  const reference = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/test-contracts/fixtures/agent-segment-reduction.reference.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const state = new AgentSegmentStateMachine(
    reference.initialProviderTurnState,
  );
  for (const item of reference.trace)
    state.accept(kernelEvent(item, reference));
  state.validateContinuation();
  assert.deepEqual(
    {
      output: state.output,
      lastSequence: state.lastAgentSequence,
      checkpointSequence: state.checkpointSequence,
      providerTurnState: state.providerTurnState,
      requestedToolSequences: state.requestedTools.map(
        ({ sequence }) => sequence,
      ),
      continuationSequence: state.assistantContinuation?.sequence,
    },
    reference.expected,
  );

  const duplicate = new AgentSegmentStateMachine(null);
  duplicate.accept(
    kernelEvent({ sequence: 1, type: "checkpointed" }, reference),
  );
  assert.throws(
    () =>
      duplicate.accept(
        kernelEvent({ sequence: 2, type: "checkpointed" }, reference),
      ),
    new RegExp(reference.invalid.duplicateCheckpointError),
  );
  const mismatch = new AgentSegmentStateMachine(null);
  assert.throws(
    () =>
      mismatch.accept(
        kernelEvent(
          { sequence: 1, type: "completed", output: "forged" },
          reference,
        ),
      ),
    new RegExp(reference.invalid.outputMismatchError),
  );
  const sequence = new AgentSegmentStateMachine(null);
  assert.throws(
    () =>
      sequence.accept(
        kernelEvent(
          { sequence: 2, type: "output_delta", delta: "gap" },
          reference,
        ),
      ),
    new RegExp(reference.invalid.sequenceMismatchError),
  );
});

function kernelEvent(item: any, reference: any): KernelAgentEvent {
  const base = {
    schemaVersion: "crewon.agent-event.v0" as const,
    runId: "run-reference",
    segmentId: "segment-reference",
    sequence: item.sequence,
  };
  switch (item.type) {
    case "provider_response_created":
      return {
        ...base,
        type: "segment.provider_response_created",
        data: { checkpoint: reference.checkpoint },
      };
    case "output_delta":
      return {
        ...base,
        type: "model.output.delta",
        data: { delta: item.delta },
      };
    case "transport_fallback":
      return {
        ...base,
        type: "model.transport.fallback",
        data: {
          fromTransport: "websocket",
          toTransport: "sse",
          code: "fallback",
          discardedOutput: item.discardedOutput,
        },
      };
    case "checkpointed":
      return {
        ...base,
        type: "segment.checkpointed",
        data: { checkpoint: reference.checkpoint },
      };
    case "tool_requested":
      return {
        ...base,
        type: "tool.requested",
        data: {
          callId: "call-1",
          kind: "function",
          name: "reference_tool",
          input: "{}",
          providerTurnState: item.providerTurnState,
        },
      };
    case "continuation_requested":
      return {
        ...base,
        type: "segment.continuation_requested",
        data: {
          output: item.output,
          completedAssistantItems: item.completedAssistantItems,
          checkpoint: reference.checkpoint,
        },
      };
    case "completed":
      return {
        ...base,
        type: "segment.completed",
        data: { output: item.output },
      };
    default:
      throw new Error(`unknown reference event: ${item.type}`);
  }
}
