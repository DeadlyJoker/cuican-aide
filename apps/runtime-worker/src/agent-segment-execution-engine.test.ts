import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentKernelPort,
  AgentSegmentContract,
  KernelAgentEvent,
} from "@crewon/agent-kernel";
import { AgentSegmentExecutionEngine } from "./agent-segment-execution-engine.ts";

test("ordinary authority preserves kernel evidence, checkpoint, event, and turn-state order", async () => {
  const calls: string[] = [];
  const kernel: AgentKernelPort = {
    modelIdentity: {
      adapterName: "test",
      adapterVersion: "1",
      modelId: "model",
    },
    async *runSegment(_contract, _signal, options) {
      await options?.controlSink?.modelRequestPrepared?.(evidence());
      calls.push("prepared");
      await options?.controlSink?.dispatchBoundaryCrossed?.(evidence());
      calls.push("possibly-sent");
      await options?.controlSink?.providerTurnStateObserved("turn-1");
      yield event(1, "segment.started", { attempt: 1, model: "model" });
      yield event(2, "segment.provider_response_created", {
        checkpoint: checkpoint(),
      });
      yield event(3, "model.output.delta", { delta: "done" });
      yield event(4, "segment.completed", {
        output: "done",
        providerTurnState: "turn-1",
      });
    },
  };
  const result = await new AgentSegmentExecutionEngine().execute({
    kernel,
    contract: contract(),
    signal: new AbortController().signal,
    providerTurnState: null,
    authority: {
      async renewLease() {
        calls.push("renew");
      },
      async cancellationRequested() {
        return false;
      },
      async checkpointProviderResponse() {
        calls.push("checkpoint");
      },
      async persistImmediateEvent() {
        calls.push("event");
      },
      async recordProviderTurnState() {
        calls.push("turn-state");
      },
    },
    controlSink: {
      async modelRequestPrepared() {
        calls.push("prepare-receipt");
      },
      async dispatchBoundaryCrossed() {
        calls.push("cross-boundary");
      },
    },
  });
  assert.deepEqual(calls, [
    "prepare-receipt",
    "prepared",
    "cross-boundary",
    "possibly-sent",
    "turn-state",
    "renew",
    "event",
    "renew",
    "checkpoint",
    "renew",
    "renew",
  ]);
  assert.equal(result.canceled, false);
  assert.equal(result.segment.output, "done");
  assert.equal(result.segment.completed, true);
  assert.equal(result.segment.providerTurnState, "turn-1");
});

test("durable cancellation wins before an uncommitted terminal event", async () => {
  const kernel: AgentKernelPort = {
    modelIdentity: {
      adapterName: "test",
      adapterVersion: "1",
      modelId: "model",
    },
    async *runSegment() {
      yield event(1, "segment.started", { attempt: 1, model: "model" });
      yield event(2, "segment.completed", { output: "" });
    },
  };
  let cancellationChecks = 0;
  const result = await new AgentSegmentExecutionEngine().execute({
    kernel,
    contract: contract(),
    signal: new AbortController().signal,
    providerTurnState: null,
    authority: {
      async renewLease() {},
      async cancellationRequested() {
        cancellationChecks += 1;
        return cancellationChecks === 2;
      },
      async checkpointProviderResponse() {},
      async persistImmediateEvent() {},
      async recordProviderTurnState() {},
    },
  });
  assert.equal(result.canceled, true);
  assert.equal(result.segment.completed, false);
  assert.equal(result.segment.lastAgentSequence, 1);
});

function event<T extends KernelAgentEvent["type"]>(
  sequence: number,
  type: T,
  data: Extract<KernelAgentEvent, { type: T }>["data"],
): Extract<KernelAgentEvent, { type: T }> {
  return {
    schemaVersion: "crewon.agent-event.v0",
    runId: "run-1",
    segmentId: "segment-1",
    sequence,
    type,
    data,
  } as Extract<KernelAgentEvent, { type: T }>;
}

function checkpoint() {
  return {
    schemaVersion: "crewon.provider-checkpoint.v0" as const,
    adapterName: "test",
    adapterVersion: "1",
    modelId: "model",
    opaquePayload: { responseId: "response-1" },
  };
}

function evidence() {
  return {
    requestSequence: 1,
    operationId: "segment-1:request:1",
    operation: "dispatch" as const,
    requestDigest: `sha256:${"a".repeat(64)}`,
    provider: {
      agentVersionId: "agent-1",
      adapterName: "test",
      adapterVersion: "1",
      modelId: "model",
    },
  };
}

function contract(): AgentSegmentContract {
  return {
    schemaVersion: "crewon.agent-segment.v0",
    purpose: "agent",
    runId: "run-1",
    segmentId: "segment-1",
    attempt: 1,
    agentVersionId: "agent-1",
    policySnapshotId: "policy-1",
    collaborationMode: "default",
    allowedTools: null,
    runtimeTools: [],
    history: [],
    continuation: { kind: "manual" },
    budget: { maxOutputBytes: 1_024 },
  };
}
