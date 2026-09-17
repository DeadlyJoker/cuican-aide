import assert from "node:assert/strict";
import test from "node:test";
import { CrewONAgentKernel } from "./crewon-agent-kernel.ts";
import {
  AgentKernelError,
  type AgentSegmentContract,
  type KernelAgentEvent,
} from "./agent-kernel-port.ts";
import {
  ModelTransportError,
  type ModelRequest,
  type ModelTransportEvent,
  type ModelTransportPort,
} from "./model-transport-port.ts";

const identity = {
  adapterName: "bounded-sampling",
  adapterVersion: "1",
  modelId: "fixture-model",
};
const contract: AgentSegmentContract = {
  schemaVersion: "crewon.agent-segment.v0",
  purpose: "agent",
  runId: "run-1",
  segmentId: "segment-1",
  attempt: 1,
  agentVersionId: "version-1",
  policySnapshotId: "policy-1",
  collaborationMode: "default",
  allowedTools: null,
  history: [{ type: "message", role: "user", content: "stable request" }],
  continuation: { kind: "manual" },
  budget: { maxOutputBytes: 32768 },
};
const fallback: ModelTransportEvent = {
  type: "transport.fallback",
  fromTransport: "websocket",
  toTransport: "http",
  code: "responses_websocket_closed",
  discardedOutput: false,
};
function unavailable(): ModelTransportError {
  return new ModelTransportError({
    category: "unavailable",
    code: "fixture_unavailable",
    retryable: true,
  });
}
function fixture(
  events: (call: number) => AsyncIterable<ModelTransportEvent>,
  retries = 1,
) {
  const requests: ModelRequest[] = [];
  let released = 0;
  const transport: ModelTransportPort = {
    ...identity,
    async *stream(request) {
      requests.push(structuredClone(request));
      if (requests.length > 20)
        throw new AgentKernelError("fixture_guard", false);
      yield* events(requests.length);
    },
    releaseRun: () => {
      released++;
    },
  };
  return {
    requests,
    released: () => released,
    kernel: new CrewONAgentKernel({
      transport,
      streamMaxRetries: retries,
      retryScheduler: { wait: async () => undefined },
    }),
  };
}
async function collect(stream: AsyncIterable<KernelAgentEvent>) {
  const result: KernelAgentEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

for (const purpose of ["agent", "compaction"] as const) {
  for (const stored of [false, true]) {
    test(`${purpose}: repeated empty ${stored ? "stored" : "manual"} continuations stop without changing the stable input`, async () => {
      const f = fixture(async function* (call) {
        const checkpoint = stored
          ? {
              schemaVersion: "crewon.provider-checkpoint.v0" as const,
              ...identity,
              opaquePayload: { responseId: `response-${call}` },
            }
          : null;
        yield {
          type: "usage",
          inputTokens: 10,
          cachedInputTokens: 6,
          cachedInputTokensReported: true,
          outputTokens: 0,
          totalTokens: 10,
        };
        yield { type: "completed", checkpoint, endTurn: false };
      });
      const observed: unknown[] = [];
      await assert.rejects(
        collect(
          f.kernel.runSegment(
            { ...contract, purpose },
            new AbortController().signal,
            {
              usageSink: {
                observed: async (value) => {
                  observed.push(value);
                },
              },
            },
          ),
        ),
        { code: "model_empty_continuation_limit_exceeded", retryable: false },
      );
      assert.equal(f.requests.length, 4);
      assert.equal(observed.length, 4);
      assert.equal(f.released(), 1);
      for (const request of f.requests)
        assert.deepEqual(request.input.items, contract.history);
      assert.equal(f.requests[0]!.input.strategy, "manual");
      assert.equal(
        f.requests[1]!.input.strategy,
        stored ? "providerCheckpoint" : "manual",
      );
    });
  }
}

test("transport fallback cannot replenish retries indefinitely", async () => {
  const f = fixture(async function* () {
    yield fallback;
    throw unavailable();
  });
  await assert.rejects(
    collect(f.kernel.runSegment(contract, new AbortController().signal)),
    { code: "model_transport_fallback_limit_exceeded", retryable: false },
  );
  assert.equal(f.requests.length, 3);
  assert.equal(f.released(), 1);
});

test("fallback events are bounded even within one transport stream", async () => {
  let produced = 0;
  let closed = false;
  const f = fixture(async function* () {
    try {
      for (let i = 0; i < 20; i++) {
        produced++;
        yield fallback;
      }
      throw new AgentKernelError("fixture_guard", false);
    } finally {
      closed = true;
    }
  });
  await assert.rejects(
    collect(f.kernel.runSegment(contract, new AbortController().signal)),
    { code: "model_transport_fallback_limit_exceeded", retryable: false },
  );
  assert.equal(produced, 3);
  assert.equal(f.requests.length, 1);
  assert.equal(closed, true);
});

test("alternating failures and successful empty samples cannot reset the total dispatch budget", async () => {
  const f = fixture(async function* (call) {
    if (call % 2) throw unavailable();
    yield { type: "completed", checkpoint: null, endTurn: false };
  });
  await assert.rejects(
    collect(f.kernel.runSegment(contract, new AbortController().signal)),
    { code: "model_sampling_request_limit_exceeded", retryable: false },
  );
  assert.equal(f.requests.length, 7);
  assert.equal(f.released(), 1);
});

test("healthy continuations retain their boundary and each new segment gets its own budget", async () => {
  const f = fixture(async function* (call) {
    if (call % 4) {
      yield { type: "completed", checkpoint: null, endTurn: false };
      return;
    }
    yield { type: "output.delta", delta: "answer" };
    yield { type: "completed", checkpoint: null };
  });
  for (const segmentId of ["segment-1", "segment-2"]) {
    const events = await collect(
      f.kernel.runSegment(
        { ...contract, segmentId },
        new AbortController().signal,
      ),
    );
    assert.equal(events.at(-1)!.type, "segment.completed");
  }
  assert.equal(f.requests.length, 8);
  assert.equal(f.released(), 2);
});

test("cancellation between empty continuation responses prevents another dispatch", async () => {
  const controller = new AbortController();
  const f = fixture(async function* () {
    yield { type: "completed", checkpoint: null, endTurn: false };
    controller.abort();
  });
  await assert.rejects(
    collect(f.kernel.runSegment(contract, controller.signal)),
    { code: "segment_canceled", retryable: false },
  );
  assert.equal(f.requests.length, 1);
  assert.equal(f.released(), 1);
});

test("ordinary Agent can yield one empty durable boundary while compaction retains its bounded loop", async () => {
  for (const purpose of ["agent", "compaction"] as const) {
    const f = fixture(async function* () {
      yield { type: "completed", checkpoint: null, endTurn: false };
    });
    const stream = collect(
      f.kernel.runSegment(
        { ...contract, purpose },
        new AbortController().signal,
        {
          emptyResponseContinuation: "durableBoundary",
        },
      ),
    );
    if (purpose === "agent") {
      const events = await stream;
      const boundary = events.at(-1);
      assert.equal(boundary?.type, "segment.continuation_requested");
      if (boundary?.type !== "segment.continuation_requested") assert.fail();
      assert.deepEqual(boundary.data, {
        output: "",
        completedAssistantItems: [],
        checkpoint: null,
      });
      assert.equal(f.requests.length, 1);
    } else {
      await assert.rejects(stream, {
        code: "model_empty_continuation_limit_exceeded",
      });
      assert.equal(f.requests.length, 4);
    }
    assert.equal(f.released(), 1);
  }
});
