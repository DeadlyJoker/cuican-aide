import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import test from "node:test";

import {
  DEVICE_PROTOCOL_VERSION,
  parseDeviceGatewayWelcome,
  type DeviceGatewayWelcome,
} from "@crewon/contracts";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { InMemoryDeviceConnectionRouteStore } from "./device-connection-route-store.ts";
import {
  DeviceGateway,
  type DeviceGatewayHeartbeatScheduler,
} from "./device-gateway.ts";
import type { DeviceGatewaySession } from "./device-gateway-session.ts";
import type { DeviceIdentityVerifierPort } from "./device-identity.ts";

test("fences an old Gateway session after a newer authenticated connection claims the Device epoch", async (context) => {
  const now = () => new Date("2026-08-09T00:00:00.000Z");
  const routes = new InMemoryDeviceConnectionRouteStore(now);
  const firstScheduler = new ManualHeartbeatScheduler();
  const secondScheduler = new ManualHeartbeatScheduler();
  const first = await openGatewayFixture(
    "gateway-1",
    "connection-1",
    routes,
    firstScheduler,
  );
  const second = await openGatewayFixture(
    "gateway-2",
    "connection-2",
    routes,
    secondScheduler,
  );
  context.after(async () => {
    await Promise.all([first.close(), second.close()]);
  });

  assert.equal((await first.accepted).hello.connectionId, "connection-1");
  assert.equal((await second.accepted).hello.connectionId, "connection-2");
  const firstWelcome = await first.welcome;
  const secondWelcome = await second.welcome;
  assert.deepEqual(
    [firstWelcome.connectionEpoch, secondWelcome.connectionEpoch],
    [1, 2],
  );
  const highestDeviceEpoch = Math.max(
    firstWelcome.connectionEpoch,
    secondWelcome.connectionEpoch,
  );
  assert.ok(firstWelcome.connectionEpoch < highestDeviceEpoch);
  assert.deepEqual(projection(await routes.loadConnection("device-1")), {
    deviceId: "device-1",
    gatewayId: "gateway-2",
    connectionId: "connection-2",
    epoch: 2,
  });

  const firstClosed = once(first.client, "close");
  await firstScheduler.tick();
  await firstClosed;
  assert.equal(first.gateway.session("device-1"), null);
  assert.equal(
    second.gateway.session("device-1")?.hello.connectionId,
    "connection-2",
  );
  assert.equal(firstScheduler.activeCount(), 0);
  assert.equal(secondScheduler.activeCount(), 1);

  await first.gateway.close();
  assert.equal(
    (await routes.loadConnection("device-1"))?.gatewayId,
    "gateway-2",
  );
  await second.gateway.close();
  assert.equal(await routes.loadConnection("device-1"), null);
  assert.equal(
    (
      await routes.claimConnection({
        deviceId: "device-1",
        gatewayId: "gateway-3",
        connectionId: "connection-3",
        leaseDurationMs: 30_000,
      })
    ).epoch,
    3,
  );
});

class ManualHeartbeatScheduler implements DeviceGatewayHeartbeatScheduler {
  readonly #callbacks = new Set<() => void>();

  every(_intervalMs: number, callback: () => void): () => void {
    this.#callbacks.add(callback);
    return () => this.#callbacks.delete(callback);
  }

  async tick(): Promise<void> {
    for (const callback of [...this.#callbacks]) {
      callback();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  activeCount(): number {
    return this.#callbacks.size;
  }
}

async function openGatewayFixture(
  gatewayId: string,
  connectionId: string,
  routes: InMemoryDeviceConnectionRouteStore,
  scheduler: DeviceGatewayHeartbeatScheduler,
) {
  const server = createServer();
  const webSocketServer = new WebSocketServer({ server });
  const identityVerifier: DeviceIdentityVerifierPort = {
    async verify(_request: IncomingMessage) {
      return {
        deviceId: "device-1",
        credentialId: "credential-1",
        authenticationMethod: "deviceKey",
        authenticatedAt: "2026-08-09T00:00:00.000Z",
      };
    },
  };
  const gateway = new DeviceGateway(identityVerifier, {
    authorizationVerifier: { verify: async () => undefined },
    now: () => new Date("2026-08-09T00:00:00.000Z"),
    connectionRoutes: {
      store: routes,
      gatewayId,
      leaseDurationMs: 30_000,
      scheduler,
    },
  });
  let resolveAccepted: (session: DeviceGatewaySession) => void;
  let rejectAccepted: (error: unknown) => void;
  const accepted = new Promise<DeviceGatewaySession>((resolve, reject) => {
    resolveAccepted = resolve;
    rejectAccepted = reject;
  });
  webSocketServer.once("connection", (socket, request) => {
    void gateway.accept(socket, request).then(resolveAccepted, rejectAccepted);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture_server_address_invalid");
  }
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  client.on("error", () => undefined);
  const welcome = new Promise<DeviceGatewayWelcome>((resolve) => {
    const onMessage = (data: RawData) => {
      const decoded = JSON.parse(rawDataBuffer(data).toString("utf8")) as {
        schemaVersion?: unknown;
      };
      if (decoded.schemaVersion === "crewon.device-welcome.v0") {
        client.off("message", onMessage);
        resolve(parseDeviceGatewayWelcome(decoded));
      }
    };
    client.on("message", onMessage);
  });
  await once(client, "open");
  client.send(
    JSON.stringify({
      schemaVersion: "crewon.device-hello.v0",
      supportedProtocolVersions: [DEVICE_PROTOCOL_VERSION],
      deviceId: "device-1",
      connectionId,
      capabilities: ["workspace.read"],
      lastAcknowledged: [],
      sentAt: "2026-08-09T00:00:00.000Z",
    }),
  );
  await accepted;
  return {
    accepted,
    welcome,
    client,
    gateway,
    async close() {
      await gateway.close();
      client.terminate();
      await closeWebSocketServer(webSocketServer, server);
    },
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

async function closeWebSocketServer(
  webSocketServer: WebSocketServer,
  server: Server,
): Promise<void> {
  const webSocketClosed = once(webSocketServer, "close");
  const serverClosed = once(server, "close");
  webSocketServer.close();
  server.close();
  await Promise.all([webSocketClosed, serverClosed]);
}

function projection(
  route: Awaited<
    ReturnType<InMemoryDeviceConnectionRouteStore["loadConnection"]>
  >,
) {
  return route === null
    ? null
    : {
        deviceId: route.deviceId,
        gatewayId: route.gatewayId,
        connectionId: route.connectionId,
        epoch: route.epoch,
      };
}
