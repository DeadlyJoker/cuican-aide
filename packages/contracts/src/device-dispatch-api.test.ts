import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVICE_DISPATCH_API_VERSION,
  parseDeviceDispatchApiError,
  parseDeviceDispatchApiRequest,
  parseDeviceDispatchApiResponse,
} from "./device-dispatch-api.ts";
import type {
  DeviceExecutionCommand,
  DeviceExecutionEvent,
} from "./device-protocol.ts";

test("parses a strict Worker dispatch request and terminal response", () => {
  const request = {
    schemaVersion: "crewon.device-dispatch-request.v0",
    apiVersion: DEVICE_DISPATCH_API_VERSION,
    operation: "execute",
    command: command(),
  } as const;
  const response = {
    schemaVersion: "crewon.device-dispatch-response.v0",
    apiVersion: DEVICE_DISPATCH_API_VERSION,
    operation: "execute",
    resolution: completed(),
  } as const;

  assert.deepEqual(parseDeviceDispatchApiRequest(request), request);
  assert.deepEqual(parseDeviceDispatchApiResponse(response), response);
});

test("rejects operation drift and inconsistent receipt identity", () => {
  assert.throws(
    () =>
      parseDeviceDispatchApiRequest({
        schemaVersion: "crewon.device-dispatch-request.v0",
        apiVersion: DEVICE_DISPATCH_API_VERSION,
        operation: "retry",
        command: command(),
      }),
    hasCode("device_dispatch_operation_invalid"),
  );
  assert.throws(
    () =>
      parseDeviceDispatchApiResponse({
        schemaVersion: "crewon.device-dispatch-response.v0",
        apiVersion: DEVICE_DISPATCH_API_VERSION,
        operation: "execute",
        resolution: {
          ...completed(),
          providerReceiptId: "receipt-2",
        },
      }),
    hasCode("device_dispatch_resolution_identity_mismatch"),
  );
});

test("parses only bounded safe Worker API errors", () => {
  const error = {
    schemaVersion: "crewon.device-dispatch-error.v0",
    apiVersion: DEVICE_DISPATCH_API_VERSION,
    code: "device_unavailable",
    retryable: true,
  } as const;
  assert.deepEqual(parseDeviceDispatchApiError(error), error);
  assert.throws(
    () => parseDeviceDispatchApiError({ ...error, detail: "secret" }),
    hasCode("device_dispatch_fields_invalid"),
  );
});

function command(): DeviceExecutionCommand {
  return {
    schemaVersion: "crewon.device-command.v0",
    protocolVersion: 1,
    deviceId: "device-1",
    leaseId: "lease-1",
    leaseEpoch: 1,
    expiresAt: "2099-08-09T00:00:00.000Z",
    runId: "run-1",
    stepId: "step-1",
    attemptId: "attempt-1",
    executionId: "execution-1",
    workspaceBindingId: "workspace-1",
    capability: "workspace.read",
    actionDigest: `sha256:${"a".repeat(64)}`,
    arguments: { path: "relative/file.txt" },
    payloadRef: null,
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 16 * 1024 * 1024,
    },
    idempotencyKey: `device:${"a".repeat(64)}`,
    traceContext: { traceparent: null, tracestate: null },
    authorization: {
      schemaVersion: "crewon.device-authorization.v0",
      scheme: "ed25519",
      keyId: "control-key-1",
      issuedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2026-08-09T00:05:00.000Z",
      approvalProof: null,
      signature: "A".repeat(86),
    },
  };
}

function completed() {
  return {
    status: "completed" as const,
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    terminal: event("execution.completed", 2),
    output: [event("execution.output", 1)],
  };
}

function event(
  type: "execution.output",
  sequence: number,
): Extract<DeviceExecutionEvent, { type: "execution.output" }>;
function event(
  type: "execution.completed",
  sequence: number,
): Extract<DeviceExecutionEvent, { type: "execution.completed" }>;
function event(
  type: "execution.output" | "execution.completed",
  sequence: number,
): DeviceExecutionEvent {
  const envelope = {
    schemaVersion: "crewon.device-event.v0" as const,
    protocolVersion: 1 as const,
    deviceId: "device-1",
    executionId: "execution-1",
    receiptId: "receipt-1",
    sequence,
    observedAt: "2026-08-09T00:00:01.000Z",
  };
  return type === "execution.output"
    ? { ...envelope, type, data: { channel: "stdout", chunk: "done" } }
    : {
        ...envelope,
        type,
        data: {
          output: "done",
          artifactRef: null,
          outputDigest: `sha256:${"b".repeat(64)}`,
          stdoutDigest: `sha256:${"c".repeat(64)}`,
          stderrDigest: `sha256:${"d".repeat(64)}`,
          exitCode: 0,
          exitSignal: null,
        },
      };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
