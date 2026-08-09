import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import test from "node:test";

import {
  DEVICE_PROTOCOL_VERSION,
  canonicalUnsignedDeviceCommandSigningPayload,
  parseDeviceExecutionAck,
  parseDeviceExecutionCancel,
  parseDeviceExecutionCommand,
  type DeviceExecutionCommand,
  type DeviceExecutionEvent,
  type UnsignedDeviceExecutionCommand,
} from "@crewon/contracts";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { DeviceGateway } from "./device-gateway.ts";
import { DeviceGatewayDispatchService } from "./device-gateway-dispatch-service.ts";
import { InMemoryDeviceDispatchStore } from "./device-dispatch-store.ts";
import { Ed25519DeviceCommandAuthorizationVerifier } from "./device-command-authorization-verifier.ts";
import type { DeviceGatewaySession } from "./device-gateway-session.ts";
import type {
  AuthenticatedDeviceIdentity,
  DeviceIdentityVerifierPort,
} from "./device-identity.ts";

const digest = `sha256:${"a".repeat(64)}`;
const commandSigningKey = generateKeyPairSync("ed25519");
const commandSigningPublicKeyPem = commandSigningKey.publicKey
  .export({
    type: "spki",
    format: "pem",
  })
  .toString();

test("runs a real WebSocket Device execution and acknowledges every sequence", async (context) => {
  const fixture = await openFixture();
  context.after(() => fixture[Symbol.asyncDispose]());
  const signal = new AbortController().signal;
  const resolutionPromise = fixture.session.execute(command(), signal);
  assert.deepEqual(
    parseDeviceExecutionCommand(
      await fixture.inbox.next("crewon.device-command.v0"),
    ),
    command(),
  );

  fixture.send(event("execution.accepted", 1));
  assert.equal(
    parseDeviceExecutionAck(await fixture.inbox.next("crewon.device-ack.v0"))
      .throughSequence,
    1,
  );
  fixture.send(event("execution.output", 2));
  assert.equal(
    parseDeviceExecutionAck(await fixture.inbox.next("crewon.device-ack.v0"))
      .throughSequence,
    2,
  );
  fixture.send(event("execution.completed", 3));
  const [ack, resolution] = await Promise.all([
    fixture.inbox.next("crewon.device-ack.v0"),
    resolutionPromise,
  ]);

  assert.equal(parseDeviceExecutionAck(ack).throughSequence, 3);
  assert.deepEqual(resolution, {
    status: "completed",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    terminal: event("execution.completed", 3),
    output: [event("execution.output", 2)],
  });
});

test("dispatches and reconciles one execution through a real WebSocket session", async (context) => {
  const fixture = await openFixture();
  context.after(() => fixture[Symbol.asyncDispose]());
  const resolutionPromise = fixture.dispatch.execute(command());
  await fixture.inbox.next("crewon.device-command.v0");
  fixture.send(event("execution.accepted", 1));
  await fixture.inbox.next("crewon.device-ack.v0");
  fixture.send(event("execution.output", 2));
  await fixture.inbox.next("crewon.device-ack.v0");
  fixture.send(event("execution.completed", 3));
  await fixture.inbox.next("crewon.device-ack.v0");

  const resolution = await resolutionPromise;
  assert.equal(resolution.status, "completed");
  assert.deepEqual(await fixture.dispatch.reconcile(command()), resolution);
});

test("sends a lease-fenced cancel and waits for the Device terminal receipt", async (context) => {
  const fixture = await openFixture();
  context.after(() => fixture[Symbol.asyncDispose]());
  const resolutionPromise = fixture.session.execute(
    command(),
    new AbortController().signal,
  );
  await fixture.inbox.next("crewon.device-command.v0");
  fixture.send(event("execution.accepted", 1));
  await fixture.inbox.next("crewon.device-ack.v0");

  fixture.session.requestCancel("execution-1", "run_canceled");
  assert.deepEqual(
    parseDeviceExecutionCancel(
      await fixture.inbox.next("crewon.device-cancel.v0"),
    ),
    {
      schemaVersion: "crewon.device-cancel.v0",
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      deviceId: "device-1",
      executionId: "execution-1",
      leaseId: "lease-1",
      leaseEpoch: 2,
      reasonCode: "run_canceled",
      requestedAt: "2026-08-08T00:00:00.000Z",
    },
  );
  fixture.send(event("execution.canceled", 2));
  const resolution = await resolutionPromise;

  assert.equal(resolution.status, "canceled");
  assert.equal(resolution.providerReceiptId, "receipt-1");
});

test("fails a stale lease acceptance closed as an unknown outcome", async (context) => {
  const fixture = await openFixture();
  context.after(() => fixture[Symbol.asyncDispose]());
  const resolutionPromise = fixture.session.execute(
    command(),
    new AbortController().signal,
  );
  await fixture.inbox.next("crewon.device-command.v0");
  fixture.send({
    ...event("execution.accepted", 1),
    data: { leaseEpoch: 1, actionDigest: digest },
  });

  assert.deepEqual(await resolutionPromise, {
    status: "unknownOutcome",
    executionId: "execution-1",
    providerReceiptId: null,
    terminal: null,
  });
  const [code] = (await once(fixture.client, "close")) as [number, Buffer];
  assert.equal(code, 1008);
});

test("returns the stable receipt as unknown outcome when the Device disconnects", async (context) => {
  const fixture = await openFixture();
  context.after(() => fixture[Symbol.asyncDispose]());
  const resolutionPromise = fixture.session.execute(
    command(),
    new AbortController().signal,
  );
  await fixture.inbox.next("crewon.device-command.v0");
  fixture.send(event("execution.accepted", 1));
  await fixture.inbox.next("crewon.device-ack.v0");
  fixture.client.close();

  assert.deepEqual(await resolutionPromise, {
    status: "unknownOutcome",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    terminal: null,
  });
});

test("resumes an acknowledged execution on a new Device connection without repeating the side effect", async (context) => {
  const opened = await beginFixture("device-1");
  await opened.accepted;
  const store = new InMemoryDeviceDispatchStore();
  const dispatch = new DeviceGatewayDispatchService({
    sessions: opened.gateway,
    authorizationVerifier: opened.authorizationVerifier,
    store,
    now: () => new Date("2026-08-08T00:00:02.000Z"),
  });
  let resumedClient: WebSocket | undefined;
  context.after(async () => {
    const dispatchClosed = dispatch.close();
    resumedClient?.terminate();
    await opened.close();
    await dispatchClosed;
  });
  let sideEffectStarts = 0;

  const first = dispatch.execute(command());
  assert.deepEqual(
    parseDeviceExecutionCommand(
      await opened.inbox.next("crewon.device-command.v0"),
    ),
    command(),
  );
  sideEffectStarts += 1;
  opened.client.send(JSON.stringify(event("execution.accepted", 1)));
  await opened.inbox.next("crewon.device-ack.v0");
  const firstClosed = once(opened.client, "close");
  opened.client.close();
  await firstClosed;
  assert.deepEqual(await first, {
    status: "unknownOutcome",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    terminal: null,
  });
  assert.equal((await store.load("execution-1"))?.resolution, null);
  await waitForGatewayConnection(opened.gateway, "device-1", null);

  resumedClient = new WebSocket(`ws://127.0.0.1:${opened.port}`, {
    headers: { authorization: "Device fixture-proof" },
  });
  resumedClient.on("error", () => undefined);
  const resumedInbox = new FrameInbox(resumedClient);
  await once(resumedClient, "open");
  resumedClient.send(
    JSON.stringify({
      schemaVersion: "crewon.device-hello.v0",
      supportedProtocolVersions: [DEVICE_PROTOCOL_VERSION],
      deviceId: "device-1",
      connectionId: "connection-2",
      capabilities: ["workspace.read"],
      lastAcknowledged: [{ executionId: "execution-1", sequence: 1 }],
      sentAt: "2026-08-08T00:00:02.000Z",
    }),
  );
  await waitForGatewayConnection(opened.gateway, "device-1", "connection-2");

  const resumed = dispatch.reconcile(command());
  const replayedCommand = parseDeviceExecutionCommand(
    await resumedInbox.next("crewon.device-command.v0"),
  );
  assert.deepEqual(replayedCommand, command());
  // The Device attaches to its existing executionId/idempotency record.
  assert.equal(sideEffectStarts, 1);
  resumedClient.send(JSON.stringify(event("execution.accepted", 1)));
  assert.equal(
    parseDeviceExecutionAck(await resumedInbox.next("crewon.device-ack.v0"))
      .throughSequence,
    1,
  );
  resumedClient.send(JSON.stringify(event("execution.output", 2)));
  assert.equal(
    parseDeviceExecutionAck(await resumedInbox.next("crewon.device-ack.v0"))
      .throughSequence,
    2,
  );
  resumedClient.send(JSON.stringify(event("execution.completed", 3)));
  await resumedInbox.next("crewon.device-ack.v0");

  assert.deepEqual(await resumed, {
    status: "completed",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    terminal: event("execution.completed", 3),
    output: [event("execution.output", 2)],
  });
  assert.equal(sideEffectStarts, 1);
  assert.equal(
    (await store.load("execution-1"))?.resolution?.status,
    "completed",
  );
});

async function waitForGatewayConnection(
  gateway: DeviceGateway,
  deviceId: string,
  connectionId: string | null,
): Promise<DeviceGatewaySession | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const session = gateway.session(deviceId);
    if (
      (connectionId === null && session === null) ||
      session?.hello.connectionId === connectionId
    ) {
      return session;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(
    connectionId === null
      ? "Gateway did not remove the closed Device session"
      : `Gateway did not accept Device connection ${connectionId}`,
  );
}

test("fails a mismatched terminal output digest closed after dispatch", async (context) => {
  const fixture = await openFixture();
  context.after(() => fixture[Symbol.asyncDispose]());
  const resolutionPromise = fixture.session.execute(
    command(),
    new AbortController().signal,
  );
  await fixture.inbox.next("crewon.device-command.v0");
  fixture.send(event("execution.accepted", 1));
  await fixture.inbox.next("crewon.device-ack.v0");
  fixture.send(event("execution.output", 2));
  await fixture.inbox.next("crewon.device-ack.v0");
  const completed = event("execution.completed", 3);
  assert.equal(completed.type, "execution.completed");
  fixture.send({
    ...completed,
    data: { ...completed.data, outputDigest: digest },
  });

  assert.deepEqual(await resolutionPromise, {
    status: "unknownOutcome",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    terminal: null,
  });
  const [code] = (await once(fixture.client, "close")) as [number, Buffer];
  assert.equal(code, 1008);
});

test("rejects an invalid Control Plane signature before Device dispatch", async (context) => {
  const fixture = await openFixture();
  context.after(() => fixture[Symbol.asyncDispose]());
  const valid = command();
  const invalid = {
    ...valid,
    authorization: {
      ...valid.authorization,
      signature: "A".repeat(86),
    },
  };

  await assert.rejects(
    fixture.session.execute(invalid, new AbortController().signal),
    hasCode("device_authorization_signature_invalid"),
  );
});

test("binds Device Hello to the independently authenticated identity", async () => {
  const opened = await beginFixture("device-2");
  await assert.rejects(
    opened.accepted,
    hasCode("device_hello_identity_mismatch"),
  );
  await opened.close();
});

class FrameInbox {
  readonly #frames: unknown[] = [];
  readonly #waiters = new Map<string, ((frame: unknown) => void)[]>();

  constructor(socket: WebSocket) {
    socket.on("message", (data: RawData) => {
      const frame = JSON.parse(rawDataBuffer(data).toString("utf8")) as {
        schemaVersion?: unknown;
      };
      const schema = String(frame.schemaVersion);
      const waiter = this.#waiters.get(schema)?.shift();
      if (waiter === undefined) {
        this.#frames.push(frame);
      } else {
        waiter(frame);
      }
    });
  }

  next(schemaVersion: string): Promise<unknown> {
    const index = this.#frames.findIndex(
      (frame) =>
        (frame as { schemaVersion?: unknown }).schemaVersion === schemaVersion,
    );
    if (index >= 0) {
      return Promise.resolve(this.#frames.splice(index, 1)[0]);
    }
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(schemaVersion) ?? [];
      waiters.push(resolve);
      this.#waiters.set(schemaVersion, waiters);
    });
  }
}

class Fixture implements AsyncDisposable {
  readonly session: DeviceGatewaySession;
  readonly dispatch: DeviceGatewayDispatchService;
  readonly client: WebSocket;
  readonly inbox: FrameInbox;
  readonly #gateway: DeviceGateway;
  readonly #webSocketServer: WebSocketServer;
  readonly #server: Server;

  constructor(config: {
    session: DeviceGatewaySession;
    dispatch: DeviceGatewayDispatchService;
    client: WebSocket;
    inbox: FrameInbox;
    gateway: DeviceGateway;
    webSocketServer: WebSocketServer;
    server: Server;
  }) {
    this.session = config.session;
    this.dispatch = config.dispatch;
    this.client = config.client;
    this.inbox = config.inbox;
    this.#gateway = config.gateway;
    this.#webSocketServer = config.webSocketServer;
    this.#server = config.server;
  }

  send(value: unknown): void {
    this.client.send(JSON.stringify(value));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const webSocketServerClosed = once(this.#webSocketServer, "close");
    const serverClosed = once(this.#server, "close");
    const dispatchClosed = this.dispatch.close();
    await this.#gateway.close();
    await dispatchClosed;
    this.client.terminate();
    this.#webSocketServer.close();
    this.#server.close();
    await Promise.all([webSocketServerClosed, serverClosed]);
  }
}

async function openFixture(): Promise<Fixture> {
  const opened = await beginFixture("device-1");
  return new Fixture({
    session: await opened.accepted,
    dispatch: new DeviceGatewayDispatchService({
      sessions: opened.gateway,
      authorizationVerifier: opened.authorizationVerifier,
      now: () => new Date("2026-08-08T00:00:00.000Z"),
    }),
    client: opened.client,
    inbox: opened.inbox,
    gateway: opened.gateway,
    webSocketServer: opened.webSocketServer,
    server: opened.server,
  });
}

async function beginFixture(helloDeviceId: string) {
  const server = createServer();
  const webSocketServer = new WebSocketServer({
    server,
    maxPayload: 128 * 1024,
  });
  const identity: AuthenticatedDeviceIdentity = {
    deviceId: "device-1",
    credentialId: "credential-1",
    authenticationMethod: "deviceKey",
    authenticatedAt: "2026-08-08T00:00:00.000Z",
  };
  const verifier: DeviceIdentityVerifierPort = {
    async verify(request: IncomingMessage) {
      assert.equal(request.headers.authorization, "Device fixture-proof");
      return identity;
    },
  };
  const authorizationVerifier = new Ed25519DeviceCommandAuthorizationVerifier(
    [
      {
        keyId: "control-key-1",
        publicKeyPem: commandSigningPublicKeyPem,
      },
    ],
    { now: () => new Date("2026-08-08T00:00:00.000Z") },
  );
  const gateway = new DeviceGateway(verifier, {
    now: () => new Date("2026-08-08T00:00:00.000Z"),
    authorizationVerifier,
  });
  let resolveFirst: (session: DeviceGatewaySession) => void;
  let rejectFirst: (error: unknown) => void;
  const accepted = new Promise<DeviceGatewaySession>((resolve, reject) => {
    resolveFirst = resolve;
    rejectFirst = reject;
  });
  let firstConnection = true;
  webSocketServer.on("connection", (socket, request) => {
    const acceptance = gateway.accept(socket, request);
    if (firstConnection) {
      firstConnection = false;
      void acceptance.then(resolveFirst!, rejectFirst!);
    } else {
      void acceptance.catch(() => undefined);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture_server_address_invalid");
  }
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`, {
    headers: { authorization: "Device fixture-proof" },
  });
  const inbox = new FrameInbox(client);
  await once(client, "open");
  client.send(
    JSON.stringify({
      schemaVersion: "crewon.device-hello.v0",
      supportedProtocolVersions: [DEVICE_PROTOCOL_VERSION],
      deviceId: helloDeviceId,
      connectionId: "connection-1",
      capabilities: ["workspace.read"],
      lastAcknowledged: [],
      sentAt: "2026-08-08T00:00:00.000Z",
    }),
  );
  return {
    accepted,
    client,
    inbox,
    gateway,
    authorizationVerifier,
    port: address.port,
    webSocketServer,
    server,
    async close() {
      const webSocketServerClosed = once(webSocketServer, "close");
      const serverClosed = once(server, "close");
      await gateway.close();
      client.terminate();
      webSocketServer.close();
      server.close();
      await Promise.all([webSocketServerClosed, serverClosed]);
    },
  };
}

function command(): DeviceExecutionCommand {
  const unsigned = {
    schemaVersion: "crewon.device-command.v0",
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    deviceId: "device-1",
    leaseId: "lease-1",
    leaseEpoch: 2,
    expiresAt: "2099-08-08T01:00:00.000Z",
    runId: "run-1",
    stepId: "step-1",
    attemptId: "attempt-1",
    executionId: "execution-1",
    workspaceBindingId: "workspace-1",
    capability: "workspace.read",
    actionDigest: digest,
    authorization: {
      schemaVersion: "crewon.device-authorization.v0",
      scheme: "ed25519",
      keyId: "control-key-1",
      issuedAt: "2026-08-08T00:00:00.000Z",
      expiresAt: "2026-08-08T00:30:00.000Z",
      approvalProof: null,
    },
    arguments: { path: "relative/file.txt" },
    payloadRef: null,
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 16 * 1024 * 1024,
    },
    idempotencyKey: "run-1:step-1:attempt-1",
    traceContext: { traceparent: null, tracestate: null },
  } satisfies UnsignedDeviceExecutionCommand;
  return {
    ...unsigned,
    authorization: {
      ...unsigned.authorization,
      signature: sign(
        null,
        Buffer.from(
          canonicalUnsignedDeviceCommandSigningPayload(unsigned),
          "utf8",
        ),
        commandSigningKey.privateKey,
      ).toString("base64url"),
    },
  };
}

function event(
  type: DeviceExecutionEvent["type"],
  sequence: number,
): DeviceExecutionEvent {
  const envelope = {
    schemaVersion: "crewon.device-event.v0" as const,
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    deviceId: "device-1",
    executionId: "execution-1",
    receiptId: "receipt-1",
    sequence,
    observedAt: "2026-08-08T00:00:01.000Z",
  };
  switch (type) {
    case "execution.accepted":
      return {
        ...envelope,
        type,
        data: { leaseEpoch: 2, actionDigest: digest },
      };
    case "execution.output":
      return { ...envelope, type, data: { channel: "stdout", chunk: "hello" } };
    case "execution.completed":
      return {
        ...envelope,
        type,
        data: {
          output: "done",
          artifactRef: null,
          outputDigest: digestOf("done"),
          stdoutDigest: digestOf("hello"),
          stderrDigest: digestOf(""),
          exitCode: 0,
          exitSignal: null,
        },
      };
    case "execution.failed":
      return {
        ...envelope,
        type,
        data: { code: "fixture_failed", retryable: false },
      };
    case "execution.canceled":
      return { ...envelope, type, data: { reasonCode: "run_canceled" } };
    case "execution.unknown_outcome":
      return { ...envelope, type, data: { providerReceiptId: "receipt-1" } };
  }
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

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}

function digestOf(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
