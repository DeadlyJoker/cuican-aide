import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEVICE_GATEWAY_WORKER_WORKSPACE_LIST_DISPATCH_PATH,
  DEVICE_PROTOCOL_VERSION,
  DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
  parseDeviceGatewayWelcome,
  parseDeviceWorkspaceListAck,
  parseDeviceWorkspaceListCommand,
  parseDeviceWorkspaceListDispatchError,
  parseDeviceWorkspaceListWorkerDispatchResponse,
  type DeviceWorkspaceListDispatchReference,
  type DeviceWorkspaceListWorkerDispatchRequest,
} from "@crewon/contracts";
import WebSocket, { type RawData } from "ws";

import { DeviceGatewayServer } from "./device-gateway-server.ts";
import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
  TEST_WORKER_CERT,
  TEST_WORKER_KEY,
} from "./mtls-test-certificates.test-support.ts";
import { SqliteDeviceDispatchStore } from "./sqlite-device-dispatch-store.ts";
import { SqliteWorkspaceDispatchStore } from "./sqlite-workspace-dispatch-store.ts";
import {
  acceptedEvent,
  command,
  completedEvent,
  completedResolution,
} from "./workspace-dispatch-store-conformance.test-support.ts";
import { WorkspaceWorkerRuntimeAuthorizer } from "./workspace-worker-runtime-authorizer.ts";

const now = () => new Date("2026-08-09T00:00:00.500Z");

test("runs local-only Workspace over a SQLite route and replays terminal after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-workspace-local-"));
  const path = join(directory, "gateway.sqlite3");
  let first: DeviceGatewayServer | null = null;
  let second: DeviceGatewayServer | null = null;
  let device: WebSocket | null = null;
  try {
    first = standaloneServer(path);
    const firstAddress = await first.listen("127.0.0.1", 0);
    const connected = await connectCompletingWorkspaceDevice(firstAddress.port);
    device = connected.socket;
    const expected = {
      ...completedResolution(),
      terminal: completedEvent({
        connectionEpoch: connected.connectionEpoch(),
      }),
    };
    assert.deepEqual(
      await workerRequest(firstAddress.port, executeRequest()),
      expected,
    );
    assert.equal(connected.commandCount(), 1);
    device.terminate();
    device = null;
    await first.close();
    first = null;

    second = standaloneServer(path);
    const secondAddress = await second.listen("127.0.0.1", 0);
    assert.deepEqual(
      await workerRequest(secondAddress.port, {
        schemaVersion: "crewon.device-workspace-list-dispatch-request.v0",
        apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
        operation: "reconcile",
        reference: reference("workspace-receipt-1"),
      }),
      expected,
    );
    assert.equal(connected.commandCount(), 1);
  } finally {
    device?.terminate();
    await first?.close().catch(() => undefined);
    await second?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("without an explicit local route Workspace remains unavailable with zero sends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-workspace-none-"));
  const path = join(directory, "gateway.sqlite3");
  const server = new DeviceGatewayServer({
    ...baseServerConfig(path),
    workspaceRouteTopology: undefined,
    connectionRoutes: undefined,
  });
  try {
    const address = await server.listen("127.0.0.1", 0);
    const error = await workerRequestError(address.port, executeRequest());
    assert.deepEqual(error, {
      schemaVersion: "crewon.device-workspace-list-dispatch-error.v0",
      apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
      code: "device_unavailable",
      retryable: true,
      certainty: "notSent",
    });
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function standaloneServer(path: string): DeviceGatewayServer {
  const workspaceStore = new SqliteWorkspaceDispatchStore(path);
  return new DeviceGatewayServer({
    ...baseServerConfig(path, workspaceStore),
    connectionRoutes: {
      store: workspaceStore,
      gatewayId: "gateway-local-1",
      leaseDurationMs: 30_000,
      scheduler: { every: () => () => undefined },
    },
    workspaceRouteTopology: "standalone",
  });
}

function baseServerConfig(
  path: string,
  workspaceStore = new SqliteWorkspaceDispatchStore(path),
) {
  return {
    tls: {
      key: TEST_SERVER_KEY,
      cert: TEST_SERVER_CERT,
      ca: TEST_CA_CERT,
    },
    identityVerifier: {
      async verify() {
        return {
          deviceId: "device-1",
          credentialId: "device-credential-1",
          authenticationMethod: "mtls" as const,
          authenticatedAt: now().toISOString(),
        };
      },
    },
    workerIdentityVerifier: {
      async verify() {
        return {
          workerId: "worker-1",
          credentialId: "credential-1",
          authenticationMethod: "mtls" as const,
          authenticatedAt: now().toISOString(),
        };
      },
    },
    authorizationVerifier: { verify: async () => undefined },
    dispatchStore: new SqliteDeviceDispatchStore(path),
    workspaceDispatchStore: workspaceStore,
    workspaceAuthorizationVerifier: { verify: async () => undefined },
    workspaceWorkerAuthorizer: new WorkspaceWorkerRuntimeAuthorizer([
      {
        workerId: "worker-1",
        credentialId: "credential-1",
        fingerprint256: Array.from({ length: 32 }, () => "AA").join(":"),
        allowedRuntimeBindingIds: ["runtime-binding-1"],
      },
    ]),
    now,
  };
}

async function connectCompletingWorkspaceDevice(port: number) {
  const socket = new WebSocket(`wss://127.0.0.1:${port}/device/v1`, {
    key: TEST_WORKER_KEY,
    cert: TEST_WORKER_CERT,
    ca: TEST_CA_CERT,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
  });
  socket.on("error", () => undefined);
  let connectionEpoch = 0;
  let commands = 0;
  let resolveWelcome: () => void = () => undefined;
  const welcomed = new Promise<void>((resolve) => {
    resolveWelcome = resolve;
  });
  socket.on("message", (data: RawData) => {
    const frame = JSON.parse(rawDataBuffer(data).toString("utf8")) as {
      schemaVersion?: unknown;
    };
    if (frame.schemaVersion === "crewon.device-welcome.v0") {
      const welcome = parseDeviceGatewayWelcome(frame);
      assert.equal(welcome.gatewayId, "gateway-local-1");
      connectionEpoch = welcome.connectionEpoch;
      resolveWelcome();
      return;
    }
    if (frame.schemaVersion === "crewon.device-workspace-list-command.v0") {
      assert.deepEqual(parseDeviceWorkspaceListCommand(frame), command());
      commands += 1;
      socket.send(JSON.stringify(acceptedEvent({ connectionEpoch })));
      return;
    }
    if (frame.schemaVersion === "crewon.device-workspace-list-ack.v0") {
      const acknowledgement = parseDeviceWorkspaceListAck(frame);
      if (acknowledgement.throughSequence === 1) {
        socket.send(JSON.stringify(completedEvent({ connectionEpoch })));
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      schemaVersion: "crewon.device-hello.v0",
      supportedProtocolVersions: [DEVICE_PROTOCOL_VERSION],
      deviceId: "device-1",
      connectionId: "connection-local-1",
      capabilities: ["workspace.list_top_level.v0"],
      lastAcknowledged: [],
      sentAt: now().toISOString(),
    }),
  );
  await welcomed;
  return {
    socket,
    commandCount: () => commands,
    connectionEpoch: () => connectionEpoch,
  };
}

function executeRequest(): DeviceWorkspaceListWorkerDispatchRequest {
  return {
    schemaVersion: "crewon.device-workspace-list-dispatch-request.v0",
    apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
    operation: "execute",
    command: command(),
  };
}

function reference(receiptId: string): DeviceWorkspaceListDispatchReference {
  const value = command();
  return {
    deviceId: value.deviceId,
    executionId: value.executionId,
    workspaceBindingId: value.workspaceBindingId,
    incarnationId: value.incarnationId,
    deviceBindingId: value.deviceBindingId,
    runtimeBindingId: value.runtimeBindingId,
    actionDigest: value.actionDigest,
    commandDigest: value.commandDigest,
    receiptId,
  };
}

async function workerRequest(
  port: number,
  input: DeviceWorkspaceListWorkerDispatchRequest,
) {
  const response = await postWorkerRequest(port, input);
  assert.equal(response.statusCode, 200);
  return parseDeviceWorkspaceListWorkerDispatchResponse(response.body, input)
    .resolution;
}

async function workerRequestError(
  port: number,
  input: DeviceWorkspaceListWorkerDispatchRequest,
) {
  const response = await postWorkerRequest(port, input);
  assert.equal(response.statusCode, 503);
  return parseDeviceWorkspaceListDispatchError(response.body);
}

async function postWorkerRequest(
  port: number,
  input: DeviceWorkspaceListWorkerDispatchRequest,
): Promise<Readonly<{ statusCode: number; body: unknown }>> {
  const body = Buffer.from(JSON.stringify(input), "utf8");
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: DEVICE_GATEWAY_WORKER_WORKSPACE_LIST_DISPATCH_PATH,
        key: TEST_WORKER_KEY,
        cert: TEST_WORKER_CERT,
        ca: TEST_CA_CERT,
        servername: "localhost",
        minVersion: "TLSv1.3",
        rejectUnauthorized: true,
        headers: {
          "content-length": String(body.byteLength),
          "content-type": "application/json; charset=utf-8",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          try {
            resolve({
              statusCode: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
