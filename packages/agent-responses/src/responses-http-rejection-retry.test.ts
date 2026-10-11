import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentKernelError,
  CrewONAgentKernel,
  type AgentSegmentContract,
  type KernelAgentEvent,
  type ModelTransportStreamOptions,
} from "@crewon/agent-kernel";
import {
  DirectResponsesTransport,
  type ResponsesFetch,
  type ResponsesTimerScheduler,
} from "./direct-responses-transport.ts";
import { TURN_STATE_HEADER } from "./turn-state.ts";

const contract: AgentSegmentContract = {
  schemaVersion: "crewon.agent-segment.v0",
  purpose: "agent",
  runId: "http-rejection-run",
  segmentId: "http-rejection-segment",
  attempt: 1,
  agentVersionId: "http-rejection-version",
  policySnapshotId: "http-rejection-policy",
  collaborationMode: "default",
  allowedTools: null,
  history: [{ type: "message", role: "user", content: "hello" }],
  continuation: { kind: "manual" },
  budget: { maxOutputBytes: 4096 },
};

class ManualIdleScheduler implements ResponsesTimerScheduler {
  #deadline: (() => void) | null = null;
  schedule(callback: () => void): () => void {
    this.#deadline = callback;
    return () => {
      if (this.#deadline === callback) this.#deadline = null;
    };
  }
  expire(): void {
    const callback = this.#deadline;
    assert.ok(callback, "the actual response still owns its idle timer");
    callback();
  }
}

type CallObservation = Parameters<
  NonNullable<ModelTransportStreamOptions["callSink"]>["record"]
>[0];

function fixture(
  respond: (
    signal: AbortSignal,
    scheduler: ManualIdleScheduler,
  ) => Response | Promise<Response>,
) {
  const scheduler = new ManualIdleScheduler();
  const observations: CallObservation[] = [];
  let posts = 0;
  const fetch: ResponsesFetch = async (_url, init) => {
    assert.equal(init?.method, "POST");
    posts += 1;
    assert.ok(init.signal);
    return respond(init.signal, scheduler);
  };
  const transport = new DirectResponsesTransport(
    {
      endpoint: "https://rejection-fixture.invalid/v1/responses",
      model: "rejection-fixture-model",
    },
    { fetch, scheduler },
  );
  const kernel = new CrewONAgentKernel({
    transport,
    streamMaxRetries: 2,
    retryScheduler: { wait: async () => undefined },
  });
  const events: KernelAgentEvent[] = [];
  const run = async (
    signal = new AbortController().signal,
    options?: Parameters<CrewONAgentKernel["runSegment"]>[2],
  ) => {
    for await (const event of kernel.runSegment(contract, signal, {
      callSink: {
        record: async (observation) => {
          observations.push(structuredClone(observation));
        },
      },
      ...options,
    }))
      events.push(event);
  };
  return { run, events, observations, posts: () => posts };
}

/** No socket or provider call: the real adapter consumes an interrupted fetch body. */
function stalledRejection(
  status: number,
  signal: AbortSignal,
  scheduler: ManualIdleScheduler,
  beforeExpire?: () => void,
): Response {
  const expireAfterHeaders = async () => {
    // The adapter must observe headers and begin body handling before expiry.
    await new Promise<void>((resolve) => setImmediate(resolve));
    beforeExpire?.();
    scheduler.expire();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener(
        "abort",
        () => controller.error(new Error("fixture_body_interrupted")),
        { once: true },
      );
    },
    pull: expireAfterHeaders,
    cancel: expireAfterHeaders,
  });
  return new Response(body, { status });
}

for (const [status, code] of [
  [408, "responses_request_timeout"],
  [409, "responses_conflict"],
  [429, "responses_rate_limited"],
  [503, "responses_provider_unavailable"],
] as const) {
  test(`temporary HTTP ${status} still uses the existing sampling retry budget`, async () => {
    const f = fixture(() =>
      Response.json({ error: { code: "server_error" } }, { status }),
    );
    await assert.rejects(f.run(), permanentKernelFailure(code));
    assert.equal(f.posts(), 3);
    assert.equal(retries(f.events), 2);
  });
}

for (const status of [429]) {
  test(`temporary HTTP ${status} body idle remains a transport retry`, async () => {
    const f = fixture((signal, scheduler) =>
      stalledRejection(status, signal, scheduler),
    );
    await assert.rejects(
      f.run(),
      permanentKernelFailure("responses_idle_timeout"),
    );
    assert.equal(f.posts(), 3);
    assert.equal(retries(f.events), 2);
  });
}

test("caller cancellation takes priority over known rejection and body idle", async () => {
  const cancellation = new AbortController();
  const f = fixture((signal, scheduler) =>
    stalledRejection(400, signal, scheduler, () =>
      cancellation.abort("user_requested"),
    ),
  );
  await assert.rejects(
    f.run(cancellation.signal),
    permanentKernelFailure("segment_canceled"),
  );
  assert.equal(f.posts(), 1);
  assert.equal(retries(f.events), 0);
  assert.equal(f.observations.at(-1)?.outcome, "canceled");
  assert.deepEqual(f.observations.at(-1)?.httpDiagnostics?.termination, {
    reason: "canceled",
    code: "segment_canceled",
  });
});

test("private accounting failure takes priority over permanent HTTP rejection without resampling", async () => {
  const f = fixture((signal, scheduler) =>
    stalledRejection(400, signal, scheduler),
  );
  let recorded = 0;
  await assert.rejects(
    f.run(new AbortController().signal, {
      callSink: {
        record: async (_observation) => {
          recorded++;
          if (recorded === 2) throw new Error("fixture_accounting_failed");
        },
      },
    }),
    permanentKernelFailure("model_call_accounting_failed"),
  );
  assert.equal(recorded, 2);
  assert.equal(f.posts(), 1);
  assert.equal(retries(f.events), 0);
});

test("private control sink failure takes priority over body idle without resampling", async () => {
  const sinkFailure = new Error("fixture_control_sink_failed");
  let scheduler: ManualIdleScheduler;
  const f = fixture((_signal, idleScheduler) => {
    scheduler = idleScheduler;
    return new Response("data: {}\n\n", {
      headers: {
        "content-type": "text/event-stream",
        [TURN_STATE_HEADER]: "fixture-private-state",
      },
    });
  });
  await assert.rejects(
    f.run(new AbortController().signal, {
      controlSink: {
        providerTurnStateObserved: async () => {
          scheduler.expire();
          throw sinkFailure;
        },
      },
    }),
    (error: unknown) => error === sinkFailure,
  );
  assert.equal(f.posts(), 1);
  assert.equal(retries(f.events), 0);
  assert.equal(
    f.observations.at(-1)?.httpDiagnostics?.termination?.reason,
    "controlSinkError",
  );
});

test("idle before response headers retains the unknown network retry policy", async () => {
  const f = fixture(async (signal, scheduler) => {
    const response = new Promise<Response>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("fixture_header_idle")),
        { once: true },
      );
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    scheduler.expire();
    return response;
  });
  await assert.rejects(
    f.run(),
    permanentKernelFailure("responses_idle_timeout"),
  );
  assert.equal(f.posts(), 3);
  assert.equal(retries(f.events), 2);
  assert.ok(
    f.observations.every(
      (observation) => observation.httpDiagnostics?.response === undefined,
    ),
  );
});

function retries(events: readonly KernelAgentEvent[]): number {
  return events.filter((event) => event.type === "model.sampling.retry").length;
}

function permanentKernelFailure(code: string) {
  return (error: unknown) =>
    error instanceof AgentKernelError &&
    error.code === code &&
    !error.retryable;
}

for (const [status, code] of [
  [400, "responses_request_rejected"],
  [404, "responses_endpoint_not_found"],
] as const) {
  test(`HTTP ${status} rejection remains permanent when its body handling expires idle`, async () => {
    const f = fixture((signal, scheduler) =>
      stalledRejection(status, signal, scheduler),
    );
    await assert.rejects(
      f.run(),
      (error: unknown) =>
        error instanceof AgentKernelError &&
        error.code === code &&
        !error.retryable,
    );
    assert.equal(f.posts(), 1);
    assert.equal(
      f.events.filter((event) => event.type === "model.sampling.retry").length,
      0,
    );
    assert.equal(f.observations.length, 2);
    const final = f.observations.at(-1)!;
    assert.equal(final.httpDiagnostics?.response?.status, status);
    assert.deepEqual(final.httpDiagnostics?.termination, {
      reason: "httpError",
      code,
    });
  });
}
