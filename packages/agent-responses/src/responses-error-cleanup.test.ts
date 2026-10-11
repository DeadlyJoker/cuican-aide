import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentKernelError,
  CrewONAgentKernel,
  ModelTransportError,
  type AgentSegmentContract,
  type KernelAgentEvent,
  type ModelRequest,
  type ModelTransportStreamOptions,
} from "@crewon/agent-kernel";
import {
  DirectResponsesTransport,
  type ResponsesTimerScheduler,
} from "./direct-responses-transport.ts";

const request: ModelRequest = {
  schemaVersion: "crewon.model-request.v0",
  runId: "error-cleanup-run",
  segmentId: "error-cleanup-segment",
  agentVersionId: "error-cleanup-version",
  instructions: null,
  input: {
    strategy: "manual",
    items: [{ type: "message", role: "user", content: "hello" }],
  },
  tools: [],
  maxOutputBytes: 4096,
};
const contract: AgentSegmentContract = {
  schemaVersion: "crewon.agent-segment.v0",
  purpose: "agent",
  runId: request.runId,
  segmentId: request.segmentId,
  attempt: 1,
  agentVersionId: request.agentVersionId,
  policySnapshotId: "error-cleanup-policy",
  collaborationMode: "default",
  allowedTools: null,
  history: request.input.items,
  continuation: { kind: "manual" },
  budget: { maxOutputBytes: request.maxOutputBytes },
};
type Observation = Parameters<
  NonNullable<ModelTransportStreamOptions["callSink"]>["record"]
>[0];

class OwnedScheduler implements ResponsesTimerScheduler {
  readonly active = new Set<() => void>();
  schedule(callback: () => void): () => void {
    this.active.add(callback);
    return () => this.active.delete(callback);
  }
}

function fixture(
  status: number,
  options: Readonly<{
    contentType?: string;
    onCancel?: () => void;
    cancellation?: () => Promise<void>;
    errorBodyBytes?: number;
  }> = {},
) {
  const scheduler = new OwnedScheduler();
  const observations: Observation[] = [];
  const events: KernelAgentEvent[] = [];
  const methods: string[] = [];
  const delays: number[] = [];
  const bodies: ReadableStream<Uint8Array>[] = [];
  const cancellationReasons: unknown[] = [];
  let canceledBodies = 0;
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://cleanup-fixture.invalid/v1/responses",
      model: "cleanup-fixture-model",
      storeResponses: true,
    },
    {
      scheduler,
      fetch: async (_input, init) => {
        methods.push(init!.method!);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (options.errorBodyBytes !== undefined)
              controller.enqueue(new Uint8Array(options.errorBodyBytes));
          },
          cancel(reason) {
            canceledBodies++;
            cancellationReasons.push(reason);
            options.onCancel?.();
            return options.cancellation?.() ?? new Promise<void>(() => {});
          },
        });
        bodies.push(body);
        return new Response(body, {
          status,
          headers: {
            "content-type": options.contentType ?? "application/json",
            "retry-after": "3",
          },
        });
      },
    },
  );
  const callOptions: ModelTransportStreamOptions = {
    callSink: {
      purpose: "agent",
      record: async (value) => {
        observations.push(structuredClone(value));
      },
    },
  };
  const kernel = new CrewONAgentKernel({
    transport,
    streamMaxRetries: 2,
    retryScheduler: {
      wait: async (delay) => {
        delays.push(delay);
      },
    },
  });
  const run = async (
    signal = new AbortController().signal,
    override?: ModelTransportStreamOptions,
  ) => {
    for await (const event of kernel.runSegment(contract, signal, {
      ...callOptions,
      ...override,
    }))
      events.push(event);
  };
  return {
    transport,
    callOptions,
    scheduler,
    observations,
    events,
    methods,
    delays,
    bodies,
    cancellationReasons,
    run,
    canceledBodies: () => canceledBodies,
  };
}

for (const [status, code, calls] of [
  [400, "responses_request_rejected", 1],
  [429, "responses_rate_limited", 3],
] as const) {
  test(`oversized HTTP ${status} body preserves null classification without awaiting reader cancel`, async () => {
    const f = fixture(status, { errorBodyBytes: 64 * 1024 + 1 });
    const error = await rejectedWithoutCleanupWait(f.run());
    assert.ok(error instanceof AgentKernelError);
    assert.equal(error.code, code);
    assert.deepEqual(f.methods, Array(calls).fill("POST"));
    assert.deepEqual(f.delays, Array(calls - 1).fill(3000));
    assert.deepEqual(
      f.cancellationReasons,
      Array(calls).fill("responses_error_body_too_large"),
    );
    assert.ok(f.bodies.every((body) => !body.locked));
    assert.equal(f.scheduler.active.size, 0);
  });
}

test("caller cancellation during oversized body cleanup still takes priority", async () => {
  const caller = new AbortController();
  const f = fixture(429, {
    errorBodyBytes: 64 * 1024 + 1,
    onCancel: () => caller.abort("user_requested"),
  });
  const error = await rejectedWithoutCleanupWait(f.run(caller.signal));
  assert.ok(error instanceof AgentKernelError);
  assert.equal(error.code, "segment_canceled");
  assert.deepEqual(f.methods, ["POST"]);
  assert.deepEqual(f.cancellationReasons, ["responses_error_body_too_large"]);
  assert.ok(f.bodies.every((body) => !body.locked));
  assert.equal(f.observations.at(-1)?.outcome, "canceled");
  assert.equal(f.scheduler.active.size, 0);
});

/** No deadline is expired and no provider socket is opened by these tests. */
async function rejectedWithoutCleanupWait(operation: Promise<unknown>) {
  type Outcome =
    | Readonly<{ kind: "pending" | "resolved" }>
    | Readonly<{ kind: "rejected"; error: unknown }>;
  const settlement: { outcome: Outcome } = { outcome: { kind: "pending" } };
  void operation.then(
    () => {
      settlement.outcome = { kind: "resolved" };
    },
    (error: unknown) => {
      settlement.outcome = { kind: "rejected", error };
    },
  );
  // Give the adapter, Kernel and durable accounting their normal asynchronous turns.
  // A forever-pending source cancel cannot own request settlement after headers.
  for (let index = 0; index < 20; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  const observed = settlement.outcome;
  assert.equal(observed.kind, "rejected", "known failure waited for cleanup");
  if (observed.kind !== "rejected") throw new Error("unreachable");
  return observed.error;
}

for (const [status, code, calls] of [
  [401, "responses_authentication_failed", 1],
  [403, "responses_permission_denied", 1],
  [422, "responses_request_rejected", 1],
  [408, "responses_request_timeout", 3],
  [409, "responses_conflict", 3],
  [503, "responses_provider_unavailable", 3],
] as const) {
  test(`Kernel preserves HTTP ${status} without awaiting permanently pending cancel`, async () => {
    const f = fixture(status);
    const error = await rejectedWithoutCleanupWait(f.run());
    assert.ok(error instanceof AgentKernelError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, false);
    assert.deepEqual(f.methods, Array(calls).fill("POST"));
    assert.equal(f.canceledBodies(), calls);
    assert.equal(
      f.events.filter((event) => event.type === "model.sampling.retry").length,
      calls - 1,
    );
    assert.deepEqual(f.delays, Array(calls - 1).fill(3000));
    assert.equal(f.scheduler.active.size, 0);
    assert.equal(f.observations.length, 2 * calls);
    assert.deepEqual(f.observations.at(-1)?.httpDiagnostics?.termination, {
      reason: "httpError",
      code,
    });
  });
}

for (const [status, code, retryable] of [
  [401, "responses_authentication_failed", false],
  [404, "responses_endpoint_not_found", false],
  [429, "responses_rate_limited", true],
  [503, "responses_provider_unavailable", true],
] as const) {
  test(`retrieve HTTP ${status} preserves classification without awaiting cancel`, async () => {
    const f = fixture(status);
    const checkpoint = {
      schemaVersion: "crewon.provider-checkpoint.v0" as const,
      ...f.transport.modelIdentity(),
      opaquePayload: { responseId: "response-to-retrieve" },
    };
    const operation = (async () => {
      for await (const _event of f.transport.stream(
        { ...request, reconcileCheckpoint: checkpoint },
        new AbortController().signal,
        f.callOptions,
      )) {
        /* consume the actual adapter */
      }
    })();
    const error = await rejectedWithoutCleanupWait(operation);
    assert.ok(error instanceof ModelTransportError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
    assert.equal(error.retryAfterMs, retryable ? 3000 : undefined);
    assert.deepEqual(f.methods, ["GET"]);
    assert.equal(f.canceledBodies(), 1);
    assert.equal(f.scheduler.active.size, 0);
  });
}

test("invalid content type fails without awaiting permanently pending cancel", async () => {
  const f = fixture(200);
  const error = await rejectedWithoutCleanupWait(f.run());
  assert.ok(error instanceof AgentKernelError);
  assert.equal(error.code, "responses_content_type_invalid");
  assert.deepEqual(f.methods, ["POST"]);
  assert.equal(f.canceledBodies(), 1);
  assert.equal(f.scheduler.active.size, 0);
  assert.deepEqual(f.observations.at(-1)?.httpDiagnostics?.termination, {
    reason: "protocolError",
    code: "responses_content_type_invalid",
  });
});

test("caller cancellation during cleanup keeps priority over the known rejection", async () => {
  const caller = new AbortController();
  const f = fixture(401, { onCancel: () => caller.abort("user_requested") });
  const error = await rejectedWithoutCleanupWait(f.run(caller.signal));
  assert.ok(error instanceof AgentKernelError);
  assert.equal(error.code, "segment_canceled");
  assert.deepEqual(f.methods, ["POST"]);
  assert.equal(f.observations.at(-1)?.outcome, "canceled");
  assert.equal(f.scheduler.active.size, 0);
});

test("durable accounting failure keeps priority without awaiting cleanup or retrying", async () => {
  const f = fixture(401);
  let records = 0;
  const error = await rejectedWithoutCleanupWait(
    f.run(new AbortController().signal, {
      callSink: {
        purpose: "agent",
        record: async () => {
          records++;
          if (records === 2) throw new Error("private_accounting_failed");
        },
      },
    }),
  );
  assert.ok(error instanceof AgentKernelError);
  assert.equal(error.code, "model_call_accounting_failed");
  assert.equal(records, 2);
  assert.deepEqual(f.methods, ["POST"]);
  assert.equal(f.scheduler.active.size, 0);
});

test("cleanup rejection cannot replace the classified error or become unhandled", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (value: unknown) => unhandled.push(value);
  process.on("unhandledRejection", onUnhandled);
  try {
    const f = fixture(401, {
      cancellation: async () => {
        throw new Error("private_cleanup_failed");
      },
    });
    const error = await rejectedWithoutCleanupWait(f.run());
    assert.ok(error instanceof AgentKernelError);
    assert.equal(error.code, "responses_authentication_failed");
    assert.deepEqual(f.methods, ["POST"]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
