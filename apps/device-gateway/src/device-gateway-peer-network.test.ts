import assert from "node:assert/strict";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:https";
import test from "node:test";

import type {
  DeviceExecutionCommand,
  DeviceGatewayDispatchResolution,
} from "@crewon/contracts";
import {
  DEVICE_PROTOCOL_VERSION,
  parseDeviceExecutionAck,
  parseDeviceExecutionCommand,
  parseDeviceGatewayWelcome,
  type DeviceExecutionEvent,
} from "@crewon/contracts";
import { HttpsDeviceDispatchClient } from "@crewon/device-dispatch";
import { Pool } from "pg";
import WebSocket, { type RawData } from "ws";

import {
  InMemoryDeviceConnectionRouteStore,
  type DeviceConnectionRoute,
  type DeviceConnectionRouteStorePort,
} from "./device-connection-route-store.ts";
import {
  InMemoryDeviceDispatchStore,
  type DeviceDispatchStorePort,
} from "./device-dispatch-store.ts";
import { DeviceGatewayPeerApi } from "./device-gateway-peer-api.ts";
import { DeviceGatewayServer } from "./device-gateway-server.ts";
import { HttpsDeviceGatewayPeerClient } from "./https-device-gateway-peer-client.ts";
import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
  TEST_WORKER_CERT,
  TEST_WORKER_KEY,
} from "./mtls-test-certificates.test-support.ts";
import { MtlsGatewayIdentityVerifier } from "./mtls-gateway-identity-verifier.ts";
import { PostgresDeviceDispatchStore } from "./postgres-device-dispatch-store.ts";

test("forwards one route-fenced dispatch over real Gateway mTLS", async (context) => {
  const calls: string[] = [];
  const api = new DeviceGatewayPeerApi({
    identityVerifier: new MtlsGatewayIdentityVerifier(
      [
        {
          gatewayId: "gateway-1",
          credentialId: "gateway-credential-1",
          fingerprint256: new X509Certificate(TEST_WORKER_CERT).fingerprint256,
          endpoint: "https://gateway-1.invalid",
        },
      ],
      { now: () => new Date() },
    ),
    dispatch: {
      async dispatchExpected(route, operation, input) {
        calls.push(`${route.gatewayId}:${route.epoch}:${operation}`);
        assert.deepEqual(input, command());
        return completed();
      },
    },
  });
  const server = createServer(
    {
      key: TEST_SERVER_KEY,
      cert: TEST_SERVER_CERT,
      ca: TEST_CA_CERT,
      minVersion: "TLSv1.3",
      requestCert: true,
      rejectUnauthorized: true,
    },
    (request, response) => {
      void api.handle(request, response).then((handled) => {
        if (!handled) {
          response.writeHead(404).end();
        }
      });
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture_server_address_invalid");
  }
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      }),
  );
  const client = new HttpsDeviceGatewayPeerClient({
    sourceGatewayId: "gateway-1",
    gateways: [
      {
        gatewayId: "gateway-2",
        credentialId: "gateway-credential-2",
        fingerprint256: new X509Certificate(TEST_SERVER_CERT).fingerprint256,
        endpoint: `https://127.0.0.1:${address.port}`,
      },
    ],
    tls: {
      key: TEST_WORKER_KEY,
      cert: TEST_WORKER_CERT,
      ca: TEST_CA_CERT,
      servername: "localhost",
    },
  });
  context.after(() => client.close());

  assert.deepEqual(
    await client.dispatch(route(), "execute", command()),
    completed(),
  );
  assert.deepEqual(calls, ["gateway-2:3:execute"]);

  const forged = new HttpsDeviceGatewayPeerClient({
    sourceGatewayId: "gateway-forged",
    gateways: [
      {
        gatewayId: "gateway-2",
        credentialId: "gateway-credential-2",
        fingerprint256: new X509Certificate(TEST_SERVER_CERT).fingerprint256,
        endpoint: `https://127.0.0.1:${address.port}`,
      },
    ],
    tls: {
      key: TEST_WORKER_KEY,
      cert: TEST_WORKER_CERT,
      ca: TEST_CA_CERT,
      servername: "localhost",
    },
  });
  context.after(() => forged.close());
  await assert.rejects(
    forged.dispatch(route(), "execute", command()),
    hasCode("gateway_identity_mismatch"),
  );
  assert.deepEqual(calls, ["gateway-2:3:execute"]);
});

test("routes a real Worker request through a non-owner Gateway to the Device owner", async () => {
  const routes = new InMemoryDeviceConnectionRouteStore();
  await exerciseRoutedWorker({
    sourceStore: new InMemoryDeviceDispatchStore(),
    targetStore: new InMemoryDeviceDispatchStore(),
    sourceRoutes: routes,
    targetRoutes: routes,
  });
});

const postgresUrl = process.env.CREWON_TEST_POSTGRES_URL;
if (postgresUrl === undefined) {
  test.skip("real peer forwarding with PostgreSQL requires CREWON_TEST_POSTGRES_URL", () =>
    undefined);
} else {
  test("routes across real mTLS Gateways with one shared PostgreSQL authority", async () => {
    const schema = `device_peer_${randomUUID().replaceAll("-", "")}`;
    try {
      const source = new PostgresDeviceDispatchStore({
        connectionString: postgresUrl,
        schema,
      });
      const target = new PostgresDeviceDispatchStore({
        connectionString: postgresUrl,
        schema,
      });
      await exerciseRoutedWorker({
        sourceStore: source,
        targetStore: target,
        sourceRoutes: source,
        targetRoutes: target,
      });
    } finally {
      await dropSchema(postgresUrl, schema);
    }
  });
}

async function exerciseRoutedWorker(config: {
  sourceStore: DeviceDispatchStorePort;
  targetStore: DeviceDispatchStorePort;
  sourceRoutes: DeviceConnectionRouteStorePort;
  targetRoutes: DeviceConnectionRouteStorePort;
}): Promise<void> {
  const target = new DeviceGatewayServer({
    tls: serverTls(),
    identityVerifier: deviceIdentityVerifier(),
    workerIdentityVerifier: workerIdentityVerifier(),
    gatewayIdentityVerifier: new MtlsGatewayIdentityVerifier([
      {
        gatewayId: "gateway-1",
        credentialId: "gateway-credential-1",
        fingerprint256: new X509Certificate(TEST_WORKER_CERT).fingerprint256,
        endpoint: "https://gateway-1.invalid",
      },
    ]),
    authorizationVerifier: { verify: async () => undefined },
    dispatchStore: config.targetStore,
    connectionRoutes: {
      store: config.targetRoutes,
      gatewayId: "gateway-2",
      leaseDurationMs: 30_000,
    },
  });
  const targetAddress = await target.listen("127.0.0.1", 0);
  const device = await connectCompletingDevice(targetAddress.port);
  const peerClient = new HttpsDeviceGatewayPeerClient({
    sourceGatewayId: "gateway-1",
    gateways: [
      {
        gatewayId: "gateway-2",
        credentialId: "gateway-credential-2",
        fingerprint256: new X509Certificate(TEST_SERVER_CERT).fingerprint256,
        endpoint: `https://127.0.0.1:${targetAddress.port}`,
      },
    ],
    tls: {
      key: TEST_WORKER_KEY,
      cert: TEST_WORKER_CERT,
      ca: TEST_CA_CERT,
      servername: "localhost",
    },
  });
  const source = new DeviceGatewayServer({
    tls: serverTls(),
    identityVerifier: deviceIdentityVerifier(),
    workerIdentityVerifier: workerIdentityVerifier(),
    authorizationVerifier: { verify: async () => undefined },
    dispatchStore: config.sourceStore,
    connectionRoutes: {
      store: config.sourceRoutes,
      gatewayId: "gateway-1",
      leaseDurationMs: 30_000,
    },
    peerDispatch: peerClient,
  });
  const sourceAddress = await source.listen("127.0.0.1", 0);
  const worker = new HttpsDeviceDispatchClient({
    endpoint: `https://127.0.0.1:${sourceAddress.port}`,
    tls: {
      key: TEST_WORKER_KEY,
      cert: TEST_WORKER_CERT,
      ca: TEST_CA_CERT,
      servername: "localhost",
    },
  });
  try {
    assert.deepEqual(
      await worker.execute(command(), new AbortController().signal),
      {
        status: "completed",
        executionId: "execution-1",
        providerReceiptId: "receipt-1",
        output: "device output",
        artifactRef: null,
      },
    );
    assert.equal(
      (await config.sourceRoutes.loadConnection("device-1"))?.gatewayId,
      "gateway-2",
    );
  } finally {
    await worker.close();
    await source.close();
    device.terminate();
    await target.close();
  }
}

function route(): DeviceConnectionRoute {
  return {
    deviceId: "device-1",
    gatewayId: "gateway-2",
    connectionId: "connection-2",
    epoch: 3,
    leaseExpiresAt: "2099-08-09T00:01:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
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
      sequence: 2,
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

function serverTls() {
  return {
    key: TEST_SERVER_KEY,
    cert: TEST_SERVER_CERT,
    ca: TEST_CA_CERT,
  };
}

function deviceIdentityVerifier() {
  return {
    async verify() {
      return {
        deviceId: "device-1",
        credentialId: "device-credential-1",
        authenticationMethod: "mtls" as const,
        authenticatedAt: new Date().toISOString(),
      };
    },
  };
}

function workerIdentityVerifier() {
  return {
    async verify() {
      return {
        workerId: "worker-1",
        credentialId: "worker-credential-1",
        authenticationMethod: "mtls" as const,
        authenticatedAt: new Date().toISOString(),
      };
    },
  };
}

async function connectCompletingDevice(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`wss://127.0.0.1:${port}/device/v1`, {
    key: TEST_WORKER_KEY,
    cert: TEST_WORKER_CERT,
    ca: TEST_CA_CERT,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
  });
  socket.on("error", () => undefined);
  let dispatched: DeviceExecutionCommand | null = null;
  let highestConnectionEpoch = 0;
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
      highestConnectionEpoch = Math.max(
        highestConnectionEpoch,
        welcome.connectionEpoch,
      );
      resolveWelcome();
      return;
    }
    if (frame.schemaVersion === "crewon.device-command.v0") {
      assert.ok(highestConnectionEpoch > 0);
      dispatched = parseDeviceExecutionCommand(frame);
      socket.send(JSON.stringify(accepted(dispatched)));
      return;
    }
    if (
      frame.schemaVersion === "crewon.device-ack.v0" &&
      parseDeviceExecutionAck(frame).throughSequence === 1 &&
      dispatched !== null
    ) {
      socket.send(JSON.stringify(deviceCompleted(dispatched)));
    }
  });
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      schemaVersion: "crewon.device-hello.v0",
      supportedProtocolVersions: [DEVICE_PROTOCOL_VERSION],
      deviceId: "device-1",
      connectionId: "connection-2",
      capabilities: ["workspace.read"],
      lastAcknowledged: [],
      sentAt: new Date().toISOString(),
    }),
  );
  await welcomed;
  return socket;
}

function accepted(command: DeviceExecutionCommand): DeviceExecutionEvent {
  return {
    ...deviceEventEnvelope(command, 1),
    type: "execution.accepted",
    data: {
      leaseEpoch: command.leaseEpoch,
      actionDigest: command.actionDigest,
    },
  };
}

function deviceCompleted(
  command: DeviceExecutionCommand,
): DeviceExecutionEvent {
  return {
    ...deviceEventEnvelope(command, 2),
    type: "execution.completed",
    data: {
      output: "device output",
      artifactRef: null,
      outputDigest: sha256("device output"),
      stdoutDigest: sha256(""),
      stderrDigest: sha256(""),
      exitCode: 0,
      exitSignal: null,
    },
  };
}

function deviceEventEnvelope(
  command: DeviceExecutionCommand,
  sequence: number,
) {
  return {
    schemaVersion: "crewon.device-event.v0" as const,
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    deviceId: command.deviceId,
    executionId: command.executionId,
    receiptId: "receipt-1",
    sequence,
    observedAt: new Date().toISOString(),
  };
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

async function dropSchema(url: string, schema: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await pool.end();
  }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
