import assert from "node:assert/strict";
import { randomUUID, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpsRequest } from "node:https";
import test from "node:test";

import {
  DEVICE_GATEWAY_WORKER_WORKSPACE_LIST_DISPATCH_PATH,
  DEVICE_PROTOCOL_VERSION,
  DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
  parseDeviceGatewayWelcome,
  parseDeviceWorkspaceListAck,
  parseDeviceWorkspaceListCommand,
  parseDeviceWorkspaceListWorkerDispatchResponse,
  type DeviceWorkspaceListWorkerDispatchRequest,
} from "@crewon/contracts";
import { Pool } from "pg";
import WebSocket, { type RawData } from "ws";

import type { DeviceConnectionRouteStorePort } from "./device-connection-route-store.ts";
import { DeviceGatewayServer } from "./device-gateway-server.ts";
import { DeviceGatewayWorkspacePeerApi } from "./device-gateway-workspace-peer-api.ts";
import { HttpsDeviceGatewayWorkspacePeerClient } from "./https-device-gateway-workspace-peer-client.ts";
import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
  TEST_WORKER_CERT,
  TEST_WORKER_KEY,
} from "./mtls-test-certificates.test-support.ts";
import { MtlsGatewayIdentityVerifier } from "./mtls-gateway-identity-verifier.ts";
import { PostgresDeviceDispatchStore } from "./postgres-device-dispatch-store.ts";
import { PostgresWorkspaceDispatchStore } from "./postgres-workspace-dispatch-store.ts";
import {
  acceptedEvent,
  command,
  completedEvent,
  completedResolution,
  route,
} from "./workspace-dispatch-store-conformance.test-support.ts";
import { WorkspaceWorkerRuntimeAuthorizer } from "./workspace-worker-runtime-authorizer.ts";

test("forwards Workspace over real TLS 1.3 with peer, route, and Worker runtime fences", async (context) => {
  const calls: unknown[] = [];
  const api = new DeviceGatewayWorkspacePeerApi({
    gatewayId: "gateway-2",
    identityVerifier: peerVerifier(),
    routes: routes(async () => connectionRoute()),
    workerAuthorizer: workerAuthorizer(),
    dispatch: {
      async execute(worker, input) {
        calls.push({ worker, input });
        return completedResolution();
      },
      reconcile: async () => assert.fail("reconcile not expected"),
      cancel: async () => assert.fail("cancel not expected"),
    },
  });
  const opened = await openPeerApi(api);
  context.after(opened.close);
  const client = clientFor(opened.port, "gateway-1");
  context.after(() => client.close());

  assert.deepEqual(
    await client.dispatch(
      { ...route(), gatewayId: "gateway-2" },
      "execute",
      command(),
      { workerId: "worker-1", credentialId: "credential-1" },
      new AbortController().signal,
    ),
    completedResolution(),
  );
  assert.deepEqual(calls, [
    {
      worker: {
        workerId: "worker-1",
        credentialId: "credential-1",
        authenticationMethod: "gatewayAssertion",
        assertingGatewayId: "gateway-1",
        authenticatedAt: "2026-08-09T00:00:00.000Z",
      },
      input: command(),
    },
  ]);

  await assert.rejects(
    client.dispatch(
      { ...route(), gatewayId: "gateway-2" },
      "execute",
      command({ runtimeBindingId: "runtime-binding-wrong" }),
      { workerId: "worker-1", credentialId: "credential-1" },
      new AbortController().signal,
    ),
    hasCode("workspace_worker_runtime_unauthorized"),
  );
  await assert.rejects(
    client.dispatch(
      { ...route(), gatewayId: "gateway-2" },
      "execute",
      command(),
      { workerId: "worker-1", credentialId: "credential-wrong" },
      new AbortController().signal,
    ),
    hasCode("workspace_worker_runtime_unauthorized"),
  );
  await assert.rejects(
    client.dispatch(
      {
        ...route(),
        gatewayId: "gateway-2",
        leaseExpiresAt: "2026-08-09T00:06:00.000Z",
      },
      "execute",
      command(),
      { workerId: "worker-1", credentialId: "credential-1" },
      new AbortController().signal,
    ),
    hasCode("workspace_dispatch_route_stale"),
  );
  await assert.rejects(
    client.dispatch(
      { ...route(), gatewayId: "gateway-2", connectionEpoch: 4 },
      "execute",
      command(),
      { workerId: "worker-1", credentialId: "credential-1" },
      new AbortController().signal,
    ),
    hasCode("workspace_dispatch_route_stale"),
  );
  const forgedGateway = clientFor(opened.port, "gateway-forged");
  context.after(() => forgedGateway.close());
  await assert.rejects(
    forgedGateway.dispatch(
      { ...route(), gatewayId: "gateway-2" },
      "execute",
      command(),
      { workerId: "worker-1", credentialId: "credential-1" },
      new AbortController().signal,
    ),
    hasCode("gateway_identity_mismatch"),
  );
  assert.equal(calls.length, 1);
});

test("fails closed on a peer response whose route identity differs", async (context) => {
  const server = createServer(serverTls(), (request, response) => {
    request.resume();
    request.once("end", () => {
      const body = Buffer.from(
        JSON.stringify({
          schemaVersion:
            "crewon.device-workspace-list-peer-dispatch-response.v0",
          apiVersion: 1,
          route: { ...route(), gatewayId: "gateway-wrong" },
          operation: "execute",
          resolution: completedResolution(),
        }),
        "utf8",
      );
      response.writeHead(200, {
        "content-length": String(body.byteLength),
        "content-type": "application/json; charset=utf-8",
      });
      response.end(body);
    });
  });
  const port = await listen(server);
  context.after(() => closeServer(server));
  const client = clientFor(port, "gateway-1");
  context.after(() => client.close());

  await assert.rejects(
    client.dispatch(
      { ...route(), gatewayId: "gateway-2" },
      "execute",
      command(),
      { workerId: "worker-1", credentialId: "credential-1" },
      new AbortController().signal,
    ),
    hasCode("workspace_peer_response_invalid"),
  );

  const wrongCertificate = clientFor(
    port,
    "gateway-1",
    Array.from({ length: 32 }, () => "AA").join(":"),
  );
  context.after(() => wrongCertificate.close());
  await assert.rejects(
    wrongCertificate.dispatch(
      { ...route(), gatewayId: "gateway-2" },
      "execute",
      command(),
      { workerId: "worker-1", credentialId: "credential-1" },
      new AbortController().signal,
    ),
    hasCode("workspace_peer_server_identity_mismatch"),
  );
});

test("caller cancellation after peer send remains possibly sent", async (context) => {
  const server = createServer(serverTls(), (request) => request.resume());
  const port = await listen(server);
  context.after(() => closeServer(server));
  const client = clientFor(port, "gateway-1");
  context.after(() => client.close());
  const controller = new AbortController();
  const pending = client.dispatch(
    { ...route(), gatewayId: "gateway-2" },
    "execute",
    command(),
    { workerId: "worker-1", credentialId: "credential-1" },
    controller.signal,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort("worker_disconnected");
  await assert.rejects(pending, hasCode("workspace_dispatch_possibly_sent"));
});

const postgresUrl = process.env.CREWON_TEST_POSTGRES_URL;
if (postgresUrl === undefined) {
  test.skip("real Workspace peer forwarding requires CREWON_TEST_POSTGRES_URL", () =>
    undefined);
} else {
  test("routes Workspace through two mTLS Gateways with PostgreSQL and replays after owner shutdown", async () => {
    const schema = `workspace_peer_${randomUUID().replaceAll("-", "")}`;
    const targetDispatch = new PostgresDeviceDispatchStore({
      connectionString: postgresUrl,
      schema,
    });
    const targetWorkspace = new PostgresWorkspaceDispatchStore({
      connectionString: postgresUrl,
      schema,
    });
    const sourceDispatch = new PostgresDeviceDispatchStore({
      connectionString: postgresUrl,
      schema,
    });
    const sourceWorkspace = new PostgresWorkspaceDispatchStore({
      connectionString: postgresUrl,
      schema,
    });
    let target: DeviceGatewayServer | null = null;
    let source: DeviceGatewayServer | null = null;
    let peerClient: HttpsDeviceGatewayWorkspacePeerClient | null = null;
    let device: WebSocket | null = null;
    try {
      target = new DeviceGatewayServer({
        tls: serverTls(),
        identityVerifier: deviceIdentityVerifier(),
        workerIdentityVerifier: workerIdentityVerifier(),
        gatewayIdentityVerifier: peerVerifier(),
        authorizationVerifier: { verify: async () => undefined },
        dispatchStore: targetDispatch,
        workspaceDispatchStore: targetWorkspace,
        workspaceAuthorizationVerifier: { verify: async () => undefined },
        workspaceWorkerAuthorizer: workerAuthorizer(),
        workspacePeerDispatch: unavailablePeer(),
        connectionRoutes: {
          store: targetDispatch,
          gatewayId: "gateway-2",
          leaseDurationMs: 30_000,
          scheduler: { every: () => () => undefined },
        },
        now: fixedNow,
      });
      const targetAddress = await target.listen("127.0.0.1", 0);
      const connected = await connectWorkspaceDevice(targetAddress.port);
      device = connected.socket;
      peerClient = clientFor(targetAddress.port, "gateway-1");
      source = new DeviceGatewayServer({
        tls: serverTls(),
        identityVerifier: deviceIdentityVerifier(),
        workerIdentityVerifier: workerIdentityVerifier(),
        gatewayIdentityVerifier: {
          verify: async () => assert.fail("peer ingress not expected"),
        },
        authorizationVerifier: { verify: async () => undefined },
        dispatchStore: sourceDispatch,
        workspaceDispatchStore: sourceWorkspace,
        workspaceAuthorizationVerifier: { verify: async () => undefined },
        workspaceWorkerAuthorizer: workerAuthorizer(),
        workspacePeerDispatch: peerClient,
        connectionRoutes: {
          store: sourceDispatch,
          gatewayId: "gateway-1",
          leaseDurationMs: 30_000,
          scheduler: { every: () => () => undefined },
        },
        now: fixedNow,
      });
      const sourceAddress = await source.listen("127.0.0.1", 0);
      const expectedResolution = {
        ...completedResolution(),
        terminal: completedEvent({
          connectionEpoch: connected.connectionEpoch(),
        }),
      };

      assert.deepEqual(
        await workspaceWorkerRequest(sourceAddress.port, {
          schemaVersion: "crewon.device-workspace-list-dispatch-request.v0",
          apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
          operation: "execute",
          command: command(),
        }),
        expectedResolution,
      );
      assert.equal(connected.commandCount(), 1);
      assert.deepEqual(
        (await sourceWorkspace.load(command().executionId))?.resolution,
        expectedResolution,
      );

      device.terminate();
      device = null;
      await target.close();
      target = null;
      const replayReference = reference("workspace-receipt-1");
      for (const operation of ["reconcile", "cancel"] as const) {
        assert.deepEqual(
          await workspaceWorkerRequest(sourceAddress.port, {
            schemaVersion: "crewon.device-workspace-list-dispatch-request.v0",
            apiVersion: DEVICE_WORKSPACE_LIST_DISPATCH_API_VERSION,
            operation,
            reference: replayReference,
          }),
          expectedResolution,
        );
      }
      assert.equal(connected.commandCount(), 1);
    } finally {
      device?.terminate();
      await source?.close().catch(() => undefined);
      await target?.close().catch(() => undefined);
      peerClient?.close();
      await Promise.allSettled([
        sourceDispatch.close(),
        sourceWorkspace.close(),
        targetDispatch.close(),
        targetWorkspace.close(),
      ]);
      await dropSchema(postgresUrl, schema);
    }
  });
}

function peerVerifier() {
  return new MtlsGatewayIdentityVerifier(
    [
      {
        gatewayId: "gateway-1",
        credentialId: "gateway-credential-1",
        fingerprint256: new X509Certificate(TEST_WORKER_CERT).fingerprint256,
        endpoint: "https://gateway-1.invalid",
      },
    ],
    { now: () => new Date("2026-08-09T00:00:00.000Z") },
  );
}

function workerAuthorizer() {
  return new WorkspaceWorkerRuntimeAuthorizer([
    {
      workerId: "worker-1",
      credentialId: "credential-1",
      fingerprint256: Array.from({ length: 32 }, () => "AA").join(":"),
      allowedRuntimeBindingIds: ["runtime-binding-1"],
    },
  ]);
}

function unavailablePeer() {
  return {
    async dispatch() {
      throw new Error("unexpected_workspace_peer_egress");
    },
  };
}

async function openPeerApi(api: DeviceGatewayWorkspacePeerApi) {
  const server = createServer(serverTls(), (request, response) => {
    void api.handle(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  const port = await listen(server);
  return { port, close: () => closeServer(server) };
}

function clientFor(
  port: number,
  sourceGatewayId: string,
  fingerprint256 = new X509Certificate(TEST_SERVER_CERT).fingerprint256,
) {
  return new HttpsDeviceGatewayWorkspacePeerClient({
    sourceGatewayId,
    gateways: [
      {
        gatewayId: "gateway-2",
        credentialId: "gateway-credential-2",
        fingerprint256,
        endpoint: `https://127.0.0.1:${port}`,
      },
    ],
    tls: {
      key: TEST_WORKER_KEY,
      cert: TEST_WORKER_CERT,
      ca: TEST_CA_CERT,
      servername: "localhost",
    },
    requestTimeoutMs: 1_000,
  });
}

function routes(
  loadConnection: DeviceConnectionRouteStorePort["loadConnection"],
): DeviceConnectionRouteStorePort {
  return {
    loadConnection,
    claimConnection: async () => assert.fail("claim not expected"),
    renewConnection: async () => assert.fail("renew not expected"),
    releaseConnection: async () => assert.fail("release not expected"),
  };
}

function connectionRoute() {
  return {
    deviceId: "device-1",
    gatewayId: "gateway-2",
    connectionId: "connection-1",
    epoch: 3,
    leaseExpiresAt: "2026-08-09T00:05:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

function fixedNow() {
  return new Date("2026-08-09T00:00:00.500Z");
}

function deviceIdentityVerifier() {
  return {
    async verify() {
      return {
        deviceId: "device-1",
        credentialId: "device-credential-1",
        authenticationMethod: "mtls" as const,
        authenticatedAt: fixedNow().toISOString(),
      };
    },
  };
}

function workerIdentityVerifier() {
  return {
    async verify() {
      return {
        workerId: "worker-1",
        credentialId: "credential-1",
        authenticationMethod: "mtls" as const,
        authenticatedAt: fixedNow().toISOString(),
      };
    },
  };
}

async function connectWorkspaceDevice(port: number) {
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
  let dispatched = command();
  let resolveWelcome: () => void = () => undefined;
  const welcomed = new Promise<void>((resolve) => {
    resolveWelcome = resolve;
  });
  socket.on("message", (data: RawData) => {
    const frame = JSON.parse(rawDataBuffer(data).toString("utf8")) as {
      schemaVersion?: unknown;
    };
    if (frame.schemaVersion === "crewon.device-welcome.v0") {
      connectionEpoch = parseDeviceGatewayWelcome(frame).connectionEpoch;
      resolveWelcome();
      return;
    }
    if (frame.schemaVersion === "crewon.device-workspace-list-command.v0") {
      dispatched = parseDeviceWorkspaceListCommand(frame);
      commands += 1;
      socket.send(JSON.stringify(acceptedEvent({ connectionEpoch })));
      return;
    }
    if (frame.schemaVersion === "crewon.device-workspace-list-ack.v0") {
      const ack = parseDeviceWorkspaceListAck(frame);
      if (ack.throughSequence === 1) {
        socket.send(JSON.stringify(completedEvent({ connectionEpoch })));
      }
    }
  });
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      schemaVersion: "crewon.device-hello.v0",
      supportedProtocolVersions: [DEVICE_PROTOCOL_VERSION],
      deviceId: "device-1",
      connectionId: "connection-1",
      capabilities: ["workspace.list_top_level.v0"],
      lastAcknowledged: [],
      sentAt: fixedNow().toISOString(),
    }),
  );
  await welcomed;
  return {
    socket,
    command: () => dispatched,
    commandCount: () => commands,
    connectionEpoch: () => connectionEpoch,
  };
}

async function workspaceWorkerRequest(
  port: number,
  input: DeviceWorkspaceListWorkerDispatchRequest,
) {
  const body = Buffer.from(JSON.stringify(input), "utf8");
  const response = await new Promise<unknown>((resolve, reject) => {
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
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.once("end", () => {
          try {
            assert.equal(incoming.statusCode, 200);
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("error", reject);
    request.end(body);
  });
  return parseDeviceWorkspaceListWorkerDispatchResponse(response, input)
    .resolution;
}

function reference(receiptId: string | null) {
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

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

async function dropSchema(
  connectionString: string,
  schema: string,
): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await pool.end();
  }
}

function serverTls() {
  return {
    key: TEST_SERVER_KEY,
    cert: TEST_SERVER_CERT,
    ca: TEST_CA_CERT,
    minVersion: "TLSv1.3" as const,
    requestCert: true,
    rejectUnauthorized: true,
  };
}

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("workspace_peer_fixture_address_invalid");
  }
  return address.port;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
