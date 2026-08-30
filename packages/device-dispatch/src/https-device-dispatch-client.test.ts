import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVICE_DISPATCH_API_VERSION,
  parseDeviceDispatchApiRequest,
  type DeviceExecutionCommand,
  type DeviceGatewayDispatchResolution,
} from "@crewon/contracts";

import {
  DeviceDispatchClientError,
  DeviceDispatchProtocolClient,
  NodeHttpsDeviceDispatchTransport,
  type DeviceDispatchHttpResponse,
  type DeviceDispatchHttpTransportPort,
} from "./https-device-dispatch-client.ts";

test("sends the exact operation and maps a Gateway terminal receipt", async () => {
  const requests: unknown[] = [];
  const client = new DeviceDispatchProtocolClient({
    async post(body) {
      requests.push(
        parseDeviceDispatchApiRequest(
          JSON.parse(Buffer.from(body).toString("utf8")),
        ),
      );
      return response(200, {
        schemaVersion: "crewon.device-dispatch-response.v0",
        apiVersion: DEVICE_DISPATCH_API_VERSION,
        operation: "execute",
        resolution: completed(),
      });
    },
    close: () => undefined,
  });

  assert.deepEqual(
    await client.execute(command(), new AbortController().signal),
    {
      status: "completed",
      executionId: "execution-1",
      providerReceiptId: "receipt-1",
      output: "device output",
      artifactRef: null,
    },
  );
  assert.deepEqual(requests, [
    {
      schemaVersion: "crewon.device-dispatch-request.v0",
      apiVersion: DEVICE_DISPATCH_API_VERSION,
      operation: "execute",
      command: command(),
    },
  ]);
});

test("preserves only a safe remote error and rejects operation drift", async () => {
  const denied = new DeviceDispatchProtocolClient(
    fixedTransport(
      response(503, {
        schemaVersion: "crewon.device-dispatch-error.v0",
        apiVersion: DEVICE_DISPATCH_API_VERSION,
        code: "device_unavailable",
        retryable: true,
      }),
    ),
  );
  await assert.rejects(
    denied.execute(command(), new AbortController().signal),
    (error) =>
      error instanceof DeviceDispatchClientError &&
      error.code === "device_unavailable" &&
      error.retryable &&
      error.statusCode === 503,
  );

  const drift = new DeviceDispatchProtocolClient(
    fixedTransport(
      response(200, {
        schemaVersion: "crewon.device-dispatch-response.v0",
        apiVersion: DEVICE_DISPATCH_API_VERSION,
        operation: "cancel",
        resolution: completed(),
      }),
    ),
  );
  await assert.rejects(
    drift.execute(command(), new AbortController().signal),
    hasCode("device_dispatch_remote_operation_mismatch"),
  );
});

test("requires HTTPS, explicit trust roots and bounded TLS settings", () => {
  assert.throws(
    () =>
      new NodeHttpsDeviceDispatchTransport({
        endpoint: "http://gateway.invalid",
        tls: { key: "key", cert: "cert", ca: "ca" },
      }),
    hasCode("device_dispatch_endpoint_invalid"),
  );
  assert.throws(
    () =>
      new NodeHttpsDeviceDispatchTransport({
        endpoint: "https://gateway.invalid",
        tls: { key: "", cert: "cert", ca: "ca" },
      }),
    hasCode("device_dispatch_tls_key_invalid"),
  );
});

function fixedTransport(
  value: DeviceDispatchHttpResponse,
): DeviceDispatchHttpTransportPort {
  return {
    post: async () => value,
    close: () => undefined,
  };
}

function response(
  statusCode: number,
  body: unknown,
): DeviceDispatchHttpResponse {
  return {
    statusCode,
    contentType: "application/json; charset=utf-8",
    body: Buffer.from(JSON.stringify(body), "utf8"),
  };
}

function completed(): DeviceGatewayDispatchResolution {
  return {
    status: "completed",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    terminal: {
      schemaVersion: "crewon.device-event.v0",
      protocolVersion: 1,
      deviceId: "device-1",
      executionId: "execution-1",
      receiptId: "receipt-1",
      sequence: 2,
      observedAt: "2026-08-09T00:00:01.000Z",
      type: "execution.completed",
      data: {
        output: "device output",
        artifactRef: null,
        outputDigest: `sha256:${"b".repeat(64)}`,
        stdoutDigest: `sha256:${"c".repeat(64)}`,
        stderrDigest: `sha256:${"d".repeat(64)}`,
        exitCode: 0,
        exitSignal: null,
      },
    },
    output: [],
  };
}

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

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
