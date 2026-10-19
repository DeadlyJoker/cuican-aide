import assert from "node:assert/strict";
import test from "node:test";
import {
  validateModelCallRecord,
  MODEL_HTTP_STREAM_COUNT_FIELDS,
  MODEL_HTTP_STREAM_COUNTER_LIMIT,
  type ModelCallRecord,
} from "./model-call-observation.ts";

const record: ModelCallRecord = {
  tenantId: "tenant",
  runId: "run",
  stepId: "step",
  attemptId: "attempt",
  observation: {
    schemaVersion: "crewon.model-call-observation.v0",
    callId: "call",
    purpose: "agent",
    agentVersionId: "agent",
    adapterName: "direct-responses",
    adapterVersion: "1",
    modelId: "model",
    transport: "http",
    operation: "generate",
    startedAt: "2026-10-10T00:00:00Z",
    finishedAt: "2026-10-10T00:00:01Z",
    outcome: "failed",
    providerResponseId: null,
    firstOutputLatencyMs: null,
    usageEventObserved: false,
  },
};

test("legacy observations and additive HTTP generation/retrieve diagnostics remain valid", () => {
  validateModelCallRecord(record);
  for (const operation of ["generate", "retrieve"] as const)
    validateModelCallRecord({
      ...record,
      observation: {
        ...record.observation,
        operation,
        httpTiming: { readClosedMs: 90, finishedMs: 100 },
        httpDiagnostics: {
          response: {
            status: 524,
            contentType: "text/html",
            server: "cloudflare",
            cfRay: "abc-SJC",
            oneApiRequestId: "request-1",
          },
          termination: {
            reason: "httpError",
            code: "responses_provider_unavailable",
            networkCode: "ECONNRESET",
          },
          read: { end: "releasedBeforeEof" },
        },
      },
    });
});

test("HTTP diagnostics reject unsupported scope, keys, header values and unbounded causes", () => {
  for (const bad of [
    null,
    [],
    { cookie: "secret" },
    { response: null },
    { response: [] },
    { response: { status: 524, authorization: "secret" } },
    { response: { status: 0 } },
    { response: { status: 600 } },
    { response: { status: "524" } },
    { response: { status: 524, cfRay: "a".repeat(129) } },
    { response: { status: 524, server: "secret\nheader" } },
    { response: { status: 524, contentType: "非ASCII" } },
    { response: { status: 524, oneApiRequestId: 123 } },
    { termination: { reason: "unknown" } },
    { termination: { reason: "transportError", message: "secret" } },
    { termination: { reason: "transportError", code: true } },
    { termination: { reason: "transportError", code: "a".repeat(129) } },
    {
      termination: {
        reason: "transportError",
        networkCode: "secret_arbitrary",
      },
    },
    { read: { end: "eof", cause: "secret" } },
    { read: { end: "unknown" } },
  ])
    assert.throws(
      () =>
        validateModelCallRecord({
          ...record,
          observation: { ...record.observation, httpDiagnostics: bad as never },
        }),
      /model_call_http_diagnostics_invalid/,
    );
  for (const patch of [
    { transport: "websocket" as const },
    { transport: "cloudAgent" as const },
    { outcome: "unknown" as const, finishedAt: null },
  ])
    assert.throws(
      () =>
        validateModelCallRecord({
          ...record,
          observation: {
            ...record.observation,
            ...patch,
            httpDiagnostics: { response: { status: 200 } },
          },
        }),
      /model_call_http_diagnostics_invalid/,
    );
});

test("optional bounded stream evidence accepts old records and refuses payload, unknown names, accessors and unbounded counters", () => {
  const stream = {
    ...Object.fromEntries(
      MODEL_HTTP_STREAM_COUNT_FIELDS.map((key) => [key, 0]),
    ),
    pendingFrameBytes: 0,
    lastEventType: "unknown",
  };
  const validate = (value: unknown) =>
    validateModelCallRecord({
      ...record,
      observation: {
        ...record.observation,
        httpTiming: { firstSemanticMs: 10, lastSemanticMs: 20 },
        httpDiagnostics: { stream: value as never },
      },
    });
  validate(stream);
  for (const patch of [
    { byteCount: -1 },
    { byteCount: Infinity },
    { byteCount: 0.5 },
    { byteCount: MODEL_HTTP_STREAM_COUNTER_LIMIT + 1 },
    { pendingFrameBytes: 256 * 1024 + 1 },
    { lastEventType: "private-event" },
    { body: "secret" },
  ])
    assert.throws(
      () => validate({ ...stream, ...patch }),
      /model_call_http_diagnostics_invalid/,
    );
  assert.throws(
    () => validate({ pendingFrameBytes: 0 }),
    /model_call_http_diagnostics_invalid/,
  );
  let reads = 0;
  const accessor = { ...stream };
  Object.defineProperty(accessor, "byteCount", {
    enumerable: true,
    get() {
      reads++;
      return 0;
    },
  });
  assert.throws(
    () => validate(accessor),
    /model_call_http_diagnostics_invalid/,
  );
  assert.equal(reads, 0);
  assert.throws(
    () => validate({ ...stream, [Symbol("secret")]: "secret" }),
    /model_call_http_diagnostics_invalid/,
  );
});

test("pending frame classification is optional, bounded, and never widens event or outcome authority", () => {
  const base = {
    ...Object.fromEntries(
      MODEL_HTTP_STREAM_COUNT_FIELDS.map((key) => [key, 0]),
    ),
    pendingFrameBytes: 28_786,
  };
  const validate = (patch: Record<string, unknown>) =>
    validateModelCallRecord({
      ...record,
      observation: {
        ...record.observation,
        httpDiagnostics: { stream: { ...base, ...patch } as never },
      },
    });
  validate({});
  for (const pendingJsonState of [
    "empty",
    "no-data",
    "done-marker",
    "complete-object",
    "complete-nonobject",
    "not-complete-json",
    "multiple-data-events",
  ])
    validate({ pendingJsonState });
  validate({
    pendingJsonState: "complete-object",
    pendingEventType: "response.completed",
  });
  validate({
    pendingJsonState: "complete-object",
    pendingEventType: "unknown",
  });
  for (const patch of [
    { pendingJsonState: undefined },
    { pendingJsonState: "raw JSON" },
    { pendingEventType: "response.completed" },
    { pendingJsonState: "done-marker", pendingEventType: "response.completed" },
    { pendingJsonState: "complete-object", pendingEventType: undefined },
    { pendingJsonState: "complete-object", pendingEventType: "private-secret" },
    { pendingJsonState: "complete-object", pendingText: "secret" },
  ])
    assert.throws(() => validate(patch), /model_call_http_diagnostics_invalid/);
  let reads = 0;
  const stream = { ...base, pendingJsonState: "complete-object" };
  Object.defineProperty(stream, "pendingEventType", {
    enumerable: true,
    get() {
      reads++;
      return "response.completed";
    },
  });
  assert.throws(
    () =>
      validateModelCallRecord({
        ...record,
        observation: {
          ...record.observation,
          httpDiagnostics: { stream: stream as never },
        },
      }),
    /model_call_http_diagnostics_invalid/,
  );
  assert.equal(reads, 0);
});
