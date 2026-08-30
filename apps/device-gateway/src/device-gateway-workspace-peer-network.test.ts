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
import {
  clientFor,
  closeServer,
  connectWorkspaceDevice,
  connectionRoute,
  deviceIdentityVerifier,
  dropSchema,
  fixedNow,
  hasCode,
  listen,
  openPeerApi,
  peerVerifier,
  rawDataBuffer,
  reference,
  routes,
  serverTls,
  unavailablePeer,
  workerAuthorizer,
  workerIdentityVerifier,
  workspaceWorkerRequest,
} from "./device-gateway-workspace-peer-network.test-support.ts";
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
