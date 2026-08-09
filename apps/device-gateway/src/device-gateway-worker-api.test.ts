import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import {
  DEVICE_DISPATCH_API_VERSION,
  DEVICE_GATEWAY_WORKER_DISPATCH_PATH,
  parseDeviceDispatchApiError,
  parseDeviceDispatchApiResponse,
  type DeviceExecutionCommand,
  type DeviceGatewayDispatchResolution,
} from "@crewon/contracts";

import { DeviceGatewayError } from "./device-gateway-error.ts";
import { DeviceGatewayWorkerApi } from "./device-gateway-worker-api.ts";

test("authenticates and dispatches one strict Worker request", async () => {
  const operations: string[] = [];
  const api = new DeviceGatewayWorkerApi({
    identityVerifier: {
      async verify() {
        return {
          workerId: "worker-1",
          credentialId: "credential-1",
          authenticationMethod: "mtls",
          authenticatedAt: "2026-08-09T00:00:00.000Z",
        };
      },
    },
    dispatch: {
      execute: async () => {
        operations.push("execute");
        return completed();
      },
      reconcile: async () => assert.fail("reconcile not expected"),
      cancel: async () => assert.fail("cancel not expected"),
    },
  });
  const response = captureResponse();

  assert.equal(
    await api.handle(request(dispatchRequest()), response.value),
    true,
  );
  assert.equal(response.statusCode(), 200);
  assert.deepEqual(parseDeviceDispatchApiResponse(response.json()), {
    schemaVersion: "crewon.device-dispatch-response.v0",
    apiVersion: DEVICE_DISPATCH_API_VERSION,
    operation: "execute",
    resolution: completed(),
  });
  assert.deepEqual(operations, ["execute"]);
});

test("rejects an unregistered Worker before reading or dispatching", async () => {
  let dispatches = 0;
  const api = new DeviceGatewayWorkerApi({
    identityVerifier: {
      verify: async () => Promise.reject(new Error("secret")),
    },
    dispatch: {
      execute: async () => {
        dispatches += 1;
        return completed();
      },
      reconcile: async () => completed(),
      cancel: async () => completed(),
    },
  });
  const response = captureResponse();

  await api.handle(request(dispatchRequest()), response.value);
  assert.equal(response.statusCode(), 403);
  assert.deepEqual(parseDeviceDispatchApiError(response.json()), {
    schemaVersion: "crewon.device-dispatch-error.v0",
    apiVersion: DEVICE_DISPATCH_API_VERSION,
    code: "worker_authentication_failed",
    retryable: false,
  });
  assert.equal(JSON.stringify(response.json()).includes("secret"), false);
  assert.equal(dispatches, 0);
});

test("fails closed on method, content type and injected request fields", async () => {
  const api = new DeviceGatewayWorkerApi({
    identityVerifier: {
      verify: async () => ({
        workerId: "worker-1",
        credentialId: "credential-1",
        authenticationMethod: "mtls",
        authenticatedAt: "2026-08-09T00:00:00.000Z",
      }),
    },
    dispatch: {
      execute: async () => completed(),
      reconcile: async () => completed(),
      cancel: async () => completed(),
    },
  });
  for (const input of [
    request(dispatchRequest(), { method: "GET" }),
    request(dispatchRequest(), { contentType: "text/plain" }),
    request({ ...dispatchRequest(), tenantId: "forged" }),
  ]) {
    const response = captureResponse();
    await api.handle(input, response.value);
    assert.ok([400, 405].includes(response.statusCode()));
  }
});

test("returns a retryable error when the current Device owner Gateway is unavailable", async () => {
  const api = new DeviceGatewayWorkerApi({
    identityVerifier: {
      verify: async () => ({
        workerId: "worker-1",
        credentialId: "credential-1",
        authenticationMethod: "mtls",
        authenticatedAt: "2026-08-09T00:00:00.000Z",
      }),
    },
    dispatch: {
      execute: async () => {
        throw new DeviceGatewayError("device_gateway_peer_unavailable");
      },
      reconcile: async () => assert.fail("reconcile not expected"),
      cancel: async () => assert.fail("cancel not expected"),
    },
  });
  const response = captureResponse();

  await api.handle(request(dispatchRequest()), response.value);
  assert.equal(response.statusCode(), 503);
  assert.deepEqual(parseDeviceDispatchApiError(response.json()), {
    schemaVersion: "crewon.device-dispatch-error.v0",
    apiVersion: DEVICE_DISPATCH_API_VERSION,
    code: "device_gateway_peer_unavailable",
    retryable: true,
  });
});

function request(
  body: unknown,
  options: Readonly<{
    method?: string;
    contentType?: string;
  }> = {},
): IncomingMessage {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  const stream = Readable.from([encoded]) as IncomingMessage;
  Object.assign(stream, {
    method: options.method ?? "POST",
    url: DEVICE_GATEWAY_WORKER_DISPATCH_PATH,
    headers: {
      "content-type": options.contentType ?? "application/json",
      "content-length": String(encoded.byteLength),
    },
  });
  return stream;
}

function captureResponse() {
  let statusCode = 0;
  let body: Uint8Array = new Uint8Array();
  const value = {
    writeHead(status: number) {
      statusCode = status;
      return this;
    },
    end(chunk?: Buffer) {
      body = chunk ?? new Uint8Array();
      return this;
    },
  } as unknown as ServerResponse;
  return {
    value,
    statusCode: () => statusCode,
    json: () => JSON.parse(Buffer.from(body).toString("utf8")) as unknown,
  };
}

function dispatchRequest() {
  return {
    schemaVersion: "crewon.device-dispatch-request.v0",
    apiVersion: DEVICE_DISPATCH_API_VERSION,
    operation: "execute" as const,
    command: command(),
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
      sequence: 1,
      observedAt: "2026-08-09T00:00:01.000Z",
      type: "execution.completed",
      data: {
        output: "done",
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
