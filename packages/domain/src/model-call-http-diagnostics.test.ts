import assert from "node:assert/strict";
import test from "node:test";
import {
  validateModelCallRecord,
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
