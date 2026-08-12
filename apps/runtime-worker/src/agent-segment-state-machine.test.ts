import assert from "node:assert/strict";
import test from "node:test";
import type { KernelAgentEvent } from "@crewon/agent-kernel";
import { AgentSegmentStateMachine } from "./agent-segment-state-machine.ts";

const event = <T extends KernelAgentEvent>(value: T): T => value;
const base = {
  schemaVersion: "crewon.agent-event.v0",
  runId: "run-1",
  segmentId: "segment-1",
} as const;

test("reduces an ordinary text segment without performing durable writes", () => {
  const state = new AgentSegmentStateMachine(null);
  assert.equal(
    state.accept(
      event({
        ...base,
        sequence: 1,
        type: "segment.started",
        data: { attempt: 1, model: "model" },
      }),
    ).kind,
    "persistEvent",
  );
  state.accept(
    event({
      ...base,
      sequence: 2,
      type: "model.output.delta",
      data: { delta: '{"answer":' },
    }),
  );
  state.accept(
    event({
      ...base,
      sequence: 3,
      type: "model.output.delta",
      data: { delta: "42}" },
    }),
  );
  state.accept(
    event({
      ...base,
      sequence: 4,
      type: "segment.completed",
      data: { output: '{"answer":42}' },
    }),
  );
  assert.deepEqual(
    {
      output: state.output,
      completed: state.completed,
      completedSequence: state.completedSequence,
      lastAgentSequence: state.lastAgentSequence,
    },
    {
      output: '{"answer":42}',
      completed: true,
      completedSequence: 4,
      lastAgentSequence: 4,
    },
  );
});

test("keeps checkpoint and tool continuation state independent of persistence", () => {
  const state = new AgentSegmentStateMachine("prior");
  const checkpoint = {
    schemaVersion: "crewon.provider-checkpoint.v0",
    adapterName: "adapter",
    adapterVersion: "v1",
    modelId: "model",
    opaquePayload: {},
  } as const;
  assert.deepEqual(
    state.accept(
      event({
        ...base,
        sequence: 1,
        type: "segment.provider_response_created",
        data: { checkpoint },
      }),
    ),
    { kind: "checkpointProviderResponse", checkpoint },
  );
  state.accept(
    event({
      ...base,
      sequence: 2,
      type: "tool.requested",
      data: {
        callId: "call-1",
        kind: "function",
        name: "read_file",
        input: "{}",
        completedAssistantItems: [],
        providerTurnState: "next",
      },
    }),
  );
  assert.deepEqual(
    {
      providerCheckpoint: state.providerCheckpoint,
      providerTurnState: state.providerTurnState,
      requestedTools: state.requestedTools,
      bufferedEvents: state.bufferedEvents,
    },
    {
      providerCheckpoint: checkpoint,
      providerTurnState: "next",
      requestedTools: state.requestedTools,
      bufferedEvents: state.requestedTools,
    },
  );
});

test("rejects duplicate checkpoints and mismatched terminal output", () => {
  const state = new AgentSegmentStateMachine(null);
  const checkpoint = {
    schemaVersion: "crewon.provider-checkpoint.v0",
    adapterName: "adapter",
    adapterVersion: "v1",
    modelId: "model",
    opaquePayload: {},
  } as const;
  state.accept(
    event({
      ...base,
      sequence: 1,
      type: "segment.checkpointed",
      data: { checkpoint },
    }),
  );
  assert.throws(
    () =>
      state.accept(
        event({
          ...base,
          sequence: 2,
          type: "segment.checkpointed",
          data: { checkpoint },
        }),
      ),
    /segment_checkpoint_duplicate/,
  );
  assert.throws(
    () =>
      state.accept(
        event({
          ...base,
          sequence: 3,
          type: "segment.completed",
          data: { output: "forged" },
        }),
      ),
    /segment_output_mismatch/,
  );
});
