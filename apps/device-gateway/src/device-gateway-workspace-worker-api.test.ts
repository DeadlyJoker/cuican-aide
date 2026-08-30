import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import {
  DEVICE_GATEWAY_WORKER_WORKSPACE_LIST_DISPATCH_PATH,
  DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
  parseDeviceWorkspaceListDispatchError,
  parseDeviceWorkspaceListWorkerDispatchResponse,
} from "@crewon/contracts";

import { DeviceGatewayWorkspaceWorkerApi } from "./device-gateway-workspace-worker-api.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import {
  command,
  completedResolution,
} from "./workspace-dispatch-store-conformance.test-support.ts";

const identity = {
  workerId: "worker-1",
  credentialId: "credential-1",
  authenticationMethod: "mtls" as const,
  authenticatedAt: "2026-08-09T00:00:00.000Z",
};

test("authenticates and dispatches the independent Workspace worker path", async () => {
  const workers: unknown[] = [];
  const api = new DeviceGatewayWorkspaceWorkerApi({
    identityVerifier: { verify: async () => identity },
    dispatch: {
      async execute(worker) {
        workers.push(worker);
        return completedResolution();
      },
      reconcile: async () => assert.fail("reconcile not expected"),
      cancel: async () => assert.fail("cancel not expected"),
    },
  });
  const requestValue = executeRequest();
  const response = captureResponse();
  assert.equal(await api.handle(request(requestValue), response.value), true);
  assert.equal(response.statusCode(), 200);
  assert.deepEqual(
    parseDeviceWorkspaceListWorkerDispatchResponse(
      response.json(),
      requestValue,
    ),
    {
      schemaVersion: "crewon.device-workspace-list-dispatch-response.v0",
      apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
      operation: "execute",
      resolution: completedResolution(),
    },
  );
  assert.deepEqual(workers, [identity]);
});

test("fails Worker authentication before reading Workspace request body", async () => {
  let dispatches = 0;
  const api = new DeviceGatewayWorkspaceWorkerApi({
    identityVerifier: {
      verify: async () => Promise.reject(new Error("secret")),
    },
    dispatch: {
      execute: async () => {
        dispatches += 1;
        return completedResolution();
      },
      reconcile: async () => completedResolution(),
      cancel: async () => completedResolution(),
    },
  });
  const response = captureResponse();
  await api.handle(request(executeRequest()), response.value);
  assert.deepEqual(parseDeviceWorkspaceListDispatchError(response.json()), {
    schemaVersion: "crewon.device-workspace-list-dispatch-error.v0",
    apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
    code: "worker_authentication_failed",
    retryable: false,
    certainty: "notSent",
  });
  assert.equal(dispatches, 0);
  assert.equal(JSON.stringify(response.json()).includes("secret"), false);
});

test("propagates HTTP disconnect cancellation with possibly-sent certainty", async () => {
  let observedAbort = false;
  const api = new DeviceGatewayWorkspaceWorkerApi({
    identityVerifier: { verify: async () => identity },
    dispatch: {
      execute: async (_worker, _command, signal) =>
        new Promise((_resolve, reject) => {
          assert.notEqual(signal, undefined);
          signal!.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(
                new DeviceGatewayError("workspace_dispatch_possibly_sent"),
              );
            },
            { once: true },
          );
        }),
      reconcile: async () => assert.fail("reconcile not expected"),
      cancel: async () => assert.fail("cancel not expected"),
    },
  });
  const response = captureResponse();
  const handling = api.handle(request(executeRequest()), response.value);
  await turn();
  response.closeBeforeEnd();
  await handling;
  assert.equal(observedAbort, true);
  assert.deepEqual(parseDeviceWorkspaceListDispatchError(response.json()), {
    schemaVersion: "crewon.device-workspace-list-dispatch-error.v0",
    apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
    code: "workspace_dispatch_possibly_sent",
    retryable: true,
    certainty: "possiblySent",
  });
});

function executeRequest() {
  return {
    schemaVersion: "crewon.device-workspace-list-dispatch-request.v0" as const,
    apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
    operation: "execute" as const,
    command: command(),
  };
}

function request(body: unknown): IncomingMessage {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  const stream = Readable.from([encoded]) as IncomingMessage;
  Object.assign(stream, {
    method: "POST",
    url: DEVICE_GATEWAY_WORKER_WORKSPACE_LIST_DISPATCH_PATH,
    headers: {
      "content-type": "application/json",
      "content-length": String(encoded.byteLength),
    },
  });
  return stream;
}

function captureResponse() {
  const emitter = new EventEmitter();
  let statusCode = 0;
  let body: Uint8Array = new Uint8Array();
  let writableEnded = false;
  const value = Object.assign(emitter, {
    get writableEnded() {
      return writableEnded;
    },
    writeHead(status: number) {
      statusCode = status;
      return this;
    },
    end(chunk?: Buffer) {
      body = chunk ?? new Uint8Array();
      writableEnded = true;
      return this;
    },
  }) as unknown as ServerResponse;
  return {
    value,
    statusCode: () => statusCode,
    json: () => JSON.parse(Buffer.from(body).toString("utf8")) as unknown,
    closeBeforeEnd: () => emitter.emit("close"),
  };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
