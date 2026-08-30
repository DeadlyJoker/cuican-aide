import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";

import {
  DEVICE_PROTOCOL_VERSION,
  parseDeviceWorkspaceListAck,
  parseDeviceWorkspaceListCommand,
  type DeviceWorkspaceListPeerRoute,
  type DeviceWorkspaceListDispatchReference,
} from "@crewon/contracts";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { InMemoryDeviceConnectionRouteStore } from "./device-connection-route-store.ts";
import { DeviceGatewayWorkspaceDispatchService } from "./device-gateway-workspace-dispatch-service.ts";
import { DeviceGateway } from "./device-gateway.ts";
import type { DeviceIdentityVerifierPort } from "./device-identity.ts";
import {
  acceptedEvent,
  command,
  completedEvent,
  completedResolution,
} from "./workspace-dispatch-store-conformance.test-support.ts";
import { InMemoryWorkspaceDispatchStore } from "./workspace-dispatch-store.ts";
import { WorkspaceWorkerRuntimeAuthorizer } from "./workspace-worker-runtime-authorizer.ts";

const now = () => new Date("2026-08-09T00:00:01.000Z");
const worker = {
  workerId: "worker-1",
  credentialId: "credential-1",
  authenticationMethod: "mtls" as const,
  authenticatedAt: "2026-08-09T00:00:00.000Z",
};

test("runs one Workspace command through the real session demux and durable ACKs", async (context) => {
  const fixture = await openFixture();
  context.after(() => fixture.close());
  const resolutionPromise = fixture.service.execute(worker, command());
  assert.deepEqual(
    parseDeviceWorkspaceListCommand(
      await fixture.inbox.next("crewon.device-workspace-list-command.v0"),
    ),
    command(),
  );
  fixture.client.send(JSON.stringify(acceptedEvent({ connectionEpoch: 1 })));
  assert.equal(
    parseDeviceWorkspaceListAck(
      await fixture.inbox.next("crewon.device-workspace-list-ack.v0"),
    ).throughSequence,
    1,
  );
  fixture.client.send(JSON.stringify(completedEvent({ connectionEpoch: 1 })));
  const [ack, resolution] = await Promise.all([
    fixture.inbox.next("crewon.device-workspace-list-ack.v0"),
    resolutionPromise,
  ]);
  const expectedResolution = {
    ...completedResolution(),
    terminal: completedEvent({ connectionEpoch: 1 }),
  };
  assert.equal(parseDeviceWorkspaceListAck(ack).throughSequence, 2);
  assert.deepEqual(resolution, expectedResolution);
  assert.deepEqual(
    (await fixture.store.load(command().executionId))?.resolution,
    expectedResolution,
  );
});

test("replays an expired accepted command through the real session journal capability", async (context) => {
  const fixture = await openFixture({
    now: () => new Date("2099-01-01T00:00:00.000Z"),
    seedAccepted: true,
    workspaceVerifier: async () =>
      assert.fail("temporal verifier not expected"),
  });
  context.after(() => fixture.close());
  const resolutionPromise = fixture.service.reconcile(worker, reference(null));
  assert.deepEqual(
    parseDeviceWorkspaceListCommand(
      await fixture.inbox.next("crewon.device-workspace-list-command.v0"),
    ),
    command(),
  );
  fixture.client.send(JSON.stringify(acceptedEvent({ connectionEpoch: 1 })));
  await fixture.inbox.next("crewon.device-workspace-list-ack.v0");
  fixture.client.send(JSON.stringify(completedEvent({ connectionEpoch: 1 })));
  await fixture.inbox.next("crewon.device-workspace-list-ack.v0");
  assert.deepEqual(await resolutionPromise, {
    ...completedResolution(),
    terminal: completedEvent({ connectionEpoch: 1 }),
  });
});

async function openFixture(
  options: Readonly<{
    now?: () => Date;
    seedAccepted?: boolean;
    workspaceVerifier?: () => Promise<void>;
  }> = {},
) {
  const fixtureNow = options.now ?? now;
  const server = createServer();
  const webSocketServer = new WebSocketServer({
    server,
    maxPayload: 128 * 1024,
  });
  const verifier: DeviceIdentityVerifierPort = {
    async verify(request: IncomingMessage) {
      assert.equal(request.headers.authorization, "Device fixture-proof");
      return {
        deviceId: "device-1",
        credentialId: "credential-1",
        authenticationMethod: "deviceKey",
        authenticatedAt: fixtureNow().toISOString(),
      };
    },
  };
  const routes = new InMemoryDeviceConnectionRouteStore(fixtureNow);
  const gateway = new DeviceGateway(verifier, {
    now: fixtureNow,
    authorizationVerifier: { verify: async () => undefined },
    connectionRoutes: {
      store: routes,
      gatewayId: "gateway-1",
      leaseDurationMs: 30_000,
      scheduler: { every: () => () => undefined },
    },
  });
  let resolveSession: () => void = () => undefined;
  const accepted = new Promise<void>((resolve) => {
    resolveSession = resolve;
  });
  webSocketServer.on("connection", (socket, request) => {
    void gateway.accept(socket, request).then(() => resolveSession());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("workspace_fixture_address_invalid");
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
      deviceId: "device-1",
      connectionId: "connection-1",
      capabilities: ["workspace.list_top_level.v0"],
      lastAcknowledged: [],
      sentAt: fixtureNow().toISOString(),
    }),
  );
  await accepted;
  await inbox.next("crewon.device-welcome.v0");
  const currentRoute: DeviceWorkspaceListPeerRoute = {
    deviceId: "device-1",
    gatewayId: "gateway-1",
    connectionId: "connection-1",
    connectionEpoch: 1,
    leaseExpiresAt: new Date(fixtureNow().getTime() + 30_000).toISOString(),
  };
  const store = new InMemoryWorkspaceDispatchStore({
    routeAuthority: { currentRoute: () => currentRoute },
    now: fixtureNow,
  });
  if (options.seedAccepted === true) {
    await store.prepare(command(), "2026-08-09T00:00:00.000Z");
    await store.acceptEvent({
      command: command(),
      route: currentRoute,
      event: acceptedEvent({ connectionEpoch: 1 }),
    });
  }
  const service = new DeviceGatewayWorkspaceDispatchService({
    sessions: gateway,
    authorizationVerifier: {
      verify: options.workspaceVerifier ?? (async () => undefined),
    },
    workerAuthorizer: new WorkspaceWorkerRuntimeAuthorizer([
      {
        workerId: "worker-1",
        credentialId: "credential-1",
        fingerprint256: Array.from({ length: 32 }, () => "AA").join(":"),
        allowedRuntimeBindingIds: ["runtime-binding-1"],
      },
    ]),
    store,
    now: fixtureNow,
  });
  return {
    client,
    inbox,
    service,
    store,
    async close() {
      const webSocketClosed = once(webSocketServer, "close");
      const serverClosed = once(server, "close");
      const serviceClosed = service.close();
      const gatewayClosed = gateway.close();
      await Promise.all([serviceClosed, gatewayClosed]);
      await store.close();
      client.terminate();
      webSocketServer.close();
      server.close();
      await Promise.all([webSocketClosed, serverClosed]);
    },
  };
}

function reference(
  receiptId: string | null,
): DeviceWorkspaceListDispatchReference {
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

class FrameInbox {
  readonly #frames: unknown[] = [];
  readonly #waiters = new Map<string, ((frame: unknown) => void)[]>();

  constructor(socket: WebSocket) {
    socket.on("message", (data: RawData) => {
      const frame = JSON.parse(rawDataBuffer(data).toString("utf8")) as {
        schemaVersion?: unknown;
      };
      const schemaVersion = String(frame.schemaVersion);
      const waiter = this.#waiters.get(schemaVersion)?.shift();
      if (waiter === undefined) this.#frames.push(frame);
      else waiter(frame);
    });
  }

  next(schemaVersion: string): Promise<unknown> {
    const index = this.#frames.findIndex(
      (frame) =>
        (frame as { schemaVersion?: unknown }).schemaVersion === schemaVersion,
    );
    if (index >= 0) return Promise.resolve(this.#frames.splice(index, 1)[0]);
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(schemaVersion) ?? [];
      waiters.push(resolve);
      this.#waiters.set(schemaVersion, waiters);
    });
  }
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
