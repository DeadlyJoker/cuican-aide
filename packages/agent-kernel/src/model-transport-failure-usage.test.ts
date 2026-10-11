import assert from "node:assert/strict";
import test from "node:test";
import type { ModelUsageObservation } from "@crewon/domain";
import {
  AgentKernelError,
  type AgentSegmentContract,
  type KernelAgentEvent,
} from "./agent-kernel-port.ts";
import { CrewONAgentKernel } from "./crewon-agent-kernel.ts";
import {
  ModelTransportError,
  type ModelRequest,
  type ModelTransportEvent,
  type ModelTransportPort,
} from "./model-transport-port.ts";
import {
  modelTransportFailureUsage,
  retainModelTransportFailureUsage,
} from "./index.ts";

type UsageEvent = Extract<ModelTransportEvent, { type: "usage" }>;
const usage: UsageEvent = {
  type: "usage",
  callId: "physical-call-1",
  providerResponseId: "response-with-invalid-tail",
  inputTokens: 100,
  cachedInputTokens: 80,
  cachedInputTokensReported: true,
  outputTokens: 10,
  totalTokens: 110,
};
function failure(retryable = false): ModelTransportError {
  return new ModelTransportError({
    category: "protocol",
    code: "fixture_terminal_poisoned",
    retryable,
  });
}

test("failure usage belongs only to the exact retained error and never its enumerable fields or cause", () => {
  const error = failure();
  const keys = Reflect.ownKeys(error);
  const serialized = JSON.stringify(error);
  retainModelTransportFailureUsage(error, usage);
  assert.deepEqual(modelTransportFailureUsage(error), usage);
  assert.deepEqual(Reflect.ownKeys(error), keys);
  assert.equal(JSON.stringify(error), serialized);
  for (const other of [
    failure(),
    new Error("wrapper", { cause: error }),
    { code: error.code, usage },
    JSON.parse(serialized),
    null,
    undefined,
    error.code,
    1,
  ])
    assert.equal(modelTransportFailureUsage(other), null);
  const opaque = new Proxy(
    {},
    {
      get() {
        throw new Error("must-not-read-fields");
      },
      getPrototypeOf() {
        throw new Error("must-not-read-prototype");
      },
    },
  );
  assert.equal(modelTransportFailureUsage(opaque), null);
  assert.throws(
    () =>
      retainModelTransportFailureUsage(
        new Error("lookalike") as ModelTransportError,
        usage,
      ),
    { code: "model_transport_failure_identity_invalid", retryable: false },
  );
});

test("failure usage captures a frozen allowlisted snapshot without evaluating getters", () => {
  const error = failure();
  let getters = 0;
  const mutable = {
    ...usage,
    get authorization() {
      getters++;
      throw new Error("credential-must-not-be-read");
    },
  };
  retainModelTransportFailureUsage(error, mutable);
  mutable.inputTokens = 999;
  mutable.providerResponseId = "changed-after-retain";
  const retained = modelTransportFailureUsage(error);
  assert.ok(retained);
  assert.deepEqual(retained, usage);
  assert.equal(Object.isFrozen(retained), true);
  assert.equal(Reflect.set(retained, "inputTokens", 999), false);
  assert.equal(getters, 0);
  assert.equal("authorization" in retained, false);
});

test("only physical call identity can be added to an existing immutable failure report", () => {
  const error = failure();
  const { callId: _callId, ...unidentified } = usage;
  retainModelTransportFailureUsage(error, unidentified);
  const first = modelTransportFailureUsage(error);
  retainModelTransportFailureUsage(error, usage);
  retainModelTransportFailureUsage(error, usage);
  retainModelTransportFailureUsage(error, unidentified);
  assert.equal(first?.callId, undefined);
  assert.deepEqual(modelTransportFailureUsage(error), usage);
  for (const changed of [
    { ...usage, callId: "another-physical-call" },
    { ...usage, providerResponseId: "another-response" },
    { ...usage, responseStatus: "failed" as const },
    { ...usage, inputTokens: 101, totalTokens: 111 },
  ]) {
    assert.throws(() => retainModelTransportFailureUsage(error, changed), {
      code: "model_transport_failure_usage_conflict",
      retryable: false,
    });
    assert.deepEqual(modelTransportFailureUsage(error), usage);
  }
});

test("malformed usage cannot become failure evidence", () => {
  for (const [event, code] of [
    [{ ...usage, type: "completed" }, "model_transport_failure_usage_invalid"],
    [{ ...usage, inputTokens: -1 }, "model_usage_invalid"],
    [{ ...usage, outputTokens: 1.5 }, "model_usage_invalid"],
    [{ ...usage, totalTokens: 111 }, "model_usage_total_mismatch"],
    [
      { ...usage, cachedInputTokens: 101 },
      "model_usage_cached_input_exceeds_input",
    ],
    [
      { ...usage, cachedInputTokens: null },
      "model_usage_cache_reporting_invalid",
    ],
    [
      { ...usage, cachedInputTokens: undefined },
      "model_usage_cache_reporting_invalid",
    ],
    [
      { ...usage, cachedInputTokensReported: false },
      "model_usage_cache_reporting_invalid",
    ],
    [
      { ...usage, responseStatus: "completed" },
      "model_usage_response_status_invalid",
    ],
    [{ ...usage, responseStatus: null }, "model_usage_response_status_invalid"],
    [
      { ...usage, providerResponseId: null },
      "model_usage_response_identity_invalid",
    ],
    [
      { ...usage, providerResponseId: " " },
      "model_usage_response_identity_invalid",
    ],
    [
      { ...usage, providerResponseId: "x".repeat(513) },
      "model_usage_response_identity_invalid",
    ],
    [{ ...usage, callId: "call\n1" }, "model_usage_call_identity_invalid"],
    [
      { ...usage, callId: "x".repeat(513) },
      "model_usage_call_identity_invalid",
    ],
  ] as const) {
    const error = failure();
    assert.throws(
      () => retainModelTransportFailureUsage(error, event as UsageEvent),
      {
        code,
        retryable: false,
      },
    );
    assert.equal(modelTransportFailureUsage(error), null);
  }
  let reads = 0;
  const getter = {
    ...usage,
    get inputTokens() {
      reads++;
      return 100;
    },
  };
  assert.throws(() => retainModelTransportFailureUsage(failure(), getter), {
    code: "model_transport_failure_usage_invalid",
  });
  assert.equal(reads, 0);
  assert.throws(
    () => retainModelTransportFailureUsage(failure(), Object.assign([], usage)),
    { code: "model_transport_failure_usage_invalid" },
  );
  const revoked = Proxy.revocable({ ...usage }, {});
  revoked.revoke();
  assert.equal(modelTransportFailureUsage(revoked.proxy), null);
  assert.throws(
    () => retainModelTransportFailureUsage(failure(), revoked.proxy),
    {
      code: "model_transport_failure_usage_invalid",
    },
  );
  const throwsOpaque = new Proxy(
    { ...usage },
    {
      getOwnPropertyDescriptor() {
        throw revoked.proxy;
      },
    },
  );
  assert.throws(
    () => retainModelTransportFailureUsage(failure(), throwsOpaque),
    {
      code: "model_transport_failure_usage_invalid",
    },
  );
});

const identity = {
  adapterName: "failure-usage-fixture",
  adapterVersion: "1",
  modelId: "fixture-model",
};
const contract: AgentSegmentContract = {
  schemaVersion: "crewon.agent-segment.v0",
  purpose: "agent",
  runId: "run-private-usage",
  segmentId: "segment-private-usage",
  attempt: 1,
  agentVersionId: "version-1",
  policySnapshotId: "policy-1",
  collaborationMode: "default",
  allowedTools: null,
  history: [
    { type: "message", role: "user", content: "stable original request" },
  ],
  continuation: { kind: "manual" },
  budget: { maxOutputBytes: 32768 },
};
function scenario(produce: () => AsyncIterable<ModelTransportEvent>) {
  const requests: ModelRequest[] = [];
  let releases = 0;
  let waits = 0;
  const transport: ModelTransportPort = {
    ...identity,
    async *stream(request) {
      requests.push(structuredClone(request));
      if (requests.length > 5) throw new Error("fixture_resampling_guard");
      yield* produce();
    },
    releaseRun() {
      releases++;
    },
  };
  return {
    requests,
    releases: () => releases,
    waits: () => waits,
    kernel: new CrewONAgentKernel({
      transport,
      streamMaxRetries: 3,
      retryScheduler: {
        wait: async () => {
          waits++;
        },
      },
    }),
  };
}
async function consume(
  stream: AsyncIterable<KernelAgentEvent>,
  events: KernelAgentEvent[],
) {
  for await (const event of stream) events.push(event);
}

for (const purpose of ["agent", "compaction"] as const) {
  for (const responseStatus of [undefined, "failed", "incomplete"] as const) {
    test(`${purpose}: ${responseStatus ?? "completed"} response evidence survives poison privately without a successful answer, checkpoint or retry`, async () => {
      const error = failure();
      const report = {
        ...usage,
        ...(responseStatus === undefined ? {} : { responseStatus }),
      };
      retainModelTransportFailureUsage(error, report);
      const f = scenario(async function* () {
        throw error;
      });
      const observed: ModelUsageObservation[] = [];
      const events: KernelAgentEvent[] = [];
      await assert.rejects(
        consume(
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
          events,
        ),
        (value) =>
          value instanceof AgentKernelError &&
          value.code === error.code &&
          value.retryable === false &&
          value.cause === error,
      );
      assert.equal(observed.length, 1);
      assert.deepEqual(observed[0]?.usage, {
        inputTokens: 100,
        cachedInputTokens: 80,
        cachedInputTokensReported: true,
        outputTokens: 10,
        totalTokens: 110,
      });
      assert.equal(observed[0]?.responseStatus, responseStatus ?? null);
      assert.equal(observed[0]?.providerResponseId, usage.providerResponseId);
      assert.equal(observed[0]?.callId, usage.callId);
      assert.equal(observed[0]?.purpose, purpose);
      assert.deepEqual(
        events.map(({ type }) => type),
        ["segment.started"],
      );
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.requests[0]?.input.items, contract.history);
      assert.equal(f.waits(), 0);
      assert.equal(f.releases(), 1);
    });
  }
}

for (const sinkFailure of [
  new Error("fixture_usage_persistence_failed"),
  null,
]) {
  test(`private accounting sink ${sinkFailure === null ? "null" : "error"} takes priority even over a retryable transport failure`, async () => {
    const error = failure(true);
    retainModelTransportFailureUsage(error, usage);
    const f = scenario(async function* () {
      throw error;
    });
    const events: KernelAgentEvent[] = [];
    let observations = 0;
    await assert.rejects(
      consume(
        f.kernel.runSegment(contract, new AbortController().signal, {
          usageSink: {
            observed: async () => {
              observations++;
              throw sinkFailure;
            },
          },
        }),
        events,
      ),
      (value) => value === sinkFailure,
    );
    assert.equal(observations, 1);
    assert.equal(f.requests.length, 1);
    assert.equal(f.waits(), 0);
    assert.equal(f.releases(), 1);
    assert.deepEqual(
      events.map(({ type }) => type),
      ["segment.started"],
    );
  });
}

test("an already delivered normal usage event is not persisted again from the same failure evidence", async () => {
  const error = failure();
  retainModelTransportFailureUsage(error, usage);
  const f = scenario(async function* () {
    yield usage;
    throw error;
  });
  const observations: ModelUsageObservation[] = [];
  const events: KernelAgentEvent[] = [];
  await assert.rejects(
    consume(
      f.kernel.runSegment(contract, new AbortController().signal, {
        usageSink: {
          observed: async (value) => {
            observations.push(value);
          },
        },
      }),
      events,
    ),
    { code: error.code, retryable: false },
  );
  assert.equal(observations.length, 1);
  assert.deepEqual(
    events.map(({ type }) => type),
    ["segment.started", "usage.recorded"],
  );
  assert.equal(f.requests.length, 1);
  assert.equal(f.waits(), 0);
});

test("normal successful usage keeps one observation and the existing public completion", async () => {
  const f = scenario(async function* () {
    yield { type: "output.delta", delta: "done" };
    yield usage;
    yield { type: "completed", checkpoint: null };
  });
  const observations: ModelUsageObservation[] = [];
  const events: KernelAgentEvent[] = [];
  await consume(
    f.kernel.runSegment(contract, new AbortController().signal, {
      usageSink: {
        observed: async (value) => {
          observations.push(value);
        },
      },
    }),
    events,
  );
  assert.equal(observations.length, 1);
  assert.deepEqual(
    events.map(({ type }) => type),
    [
      "segment.started",
      "model.output.delta",
      "usage.recorded",
      "segment.completed",
    ],
  );
  assert.equal(f.requests.length, 1);
  assert.equal(f.releases(), 1);
});

test("a transport error with a lookalike public field does not claim private accounting", async () => {
  const error = Object.assign(failure(), { usage });
  const f = scenario(async function* () {
    throw error;
  });
  let observations = 0;
  const events: KernelAgentEvent[] = [];
  await assert.rejects(
    consume(
      f.kernel.runSegment(contract, new AbortController().signal, {
        usageSink: {
          observed: async () => {
            observations++;
          },
        },
      }),
      events,
    ),
    { code: error.code, retryable: false },
  );
  assert.equal(observations, 0);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(
    events.map(({ type }) => type),
    ["segment.started"],
  );
});
