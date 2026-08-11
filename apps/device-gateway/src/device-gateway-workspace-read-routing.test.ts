import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import test from "node:test";

import {
  canonicalDeviceFilesystemReadCommandDigest,
  type DeviceFilesystemReadCommand,
  type DeviceFilesystemReadEvent,
  type DeviceFilesystemReadRouteIntent,
} from "@crewon/contracts";
import type { DeviceGatewaySession } from "./device-gateway-session.ts";
import { DeviceGatewayWorkspaceReadRouter } from "./device-gateway-workspace-read-router.ts";
import {
  sameWorkspaceReadPeerRoute,
  workspaceReadPeerNow,
} from "./device-gateway-workspace-read-api.ts";
import { DeviceGatewayWorkspaceReadService } from "./device-gateway-workspace-read-service.ts";
import { InMemoryDeviceConnectionRouteStore } from "./device-connection-route-store.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import {
  InMemoryWorkspaceReadDispatchStore,
  type WorkspaceReadRouteFence,
} from "./workspace-read-dispatch-store.ts";
import {
  clientFor,
  closeServer,
  listen,
  serverTls,
} from "./device-gateway-workspace-peer-network.test-support.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/test-contracts/fixtures/device-protocol.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const command = fixture.valid
  .filesystemReadCommand as DeviceFilesystemReadCommand;
const accepted = fixture.valid
  .filesystemReadEvents[0] as DeviceFilesystemReadEvent;
const intent: DeviceFilesystemReadRouteIntent = {
  deviceBindingId: "device-binding-1",
  runtimeBindingId: "runtime-binding-1",
};
const route: WorkspaceReadRouteFence = {
  deviceId: command.deviceId,
  gatewayId: "gateway-b",
  connectionId: "connection-1",
  connectionEpoch: 7,
  ...intent,
  capability: "workspace.read_file.v0",
  leaseExpiresAt: "2026-08-08T00:01:00Z",
};

test("router preserves full intent locally and routes only missing sessions remotely", async () => {
  const routes = new InMemoryDeviceConnectionRouteStore(
    () => new Date("2026-08-08T00:00:00Z"),
  );
  await routes.claimConnection({
    deviceId: command.deviceId,
    gatewayId: "gateway-b",
    connectionId: "connection-1",
    leaseDurationMs: 60_000,
  });
  let localIntent: DeviceFilesystemReadRouteIntent | null = null;
  let peerIntent: DeviceFilesystemReadRouteIntent | null = null;
  const router = new DeviceGatewayWorkspaceReadRouter({
    gatewayId: "gateway-a",
    routes,
    local: {
      async execute(_worker, received) {
        localIntent = received as DeviceFilesystemReadRouteIntent;
        throw new DeviceGatewayError("device_unavailable");
      },
      async reconcile() {
        throw new Error("unused");
      },
      async cancel() {
        throw new Error("unused");
      },
    },
    peers: {
      async dispatchRead(received) {
        peerIntent = {
          deviceBindingId: received.deviceBindingId,
          runtimeBindingId: received.runtimeBindingId,
        };
        return {
          status: "unknownOutcome",
          executionId: command.executionId,
          receiptId: null,
          terminal: null,
        };
      },
    },
  });
  await router.execute(worker, intent, command);
  assert.deepEqual(localIntent, intent);
  assert.deepEqual(peerIntent, intent);
});

test("cancel validates accepted lease and never replays the command", async () => {
  const store = new InMemoryWorkspaceReadDispatchStore({
    now: () => new Date("2026-08-08T00:00:05Z"),
    currentRoute: () => route,
  });
  await store.prepare(command, route, "2026-08-08T00:00:02Z");
  await store.commit({ command, route, event: accepted });
  let executions = 0;
  let cancels = 0;
  const session = {
    supportsWorkspaceRead: () => true,
    executeWorkspaceRead: () => {
      executions += 1;
      throw new Error("must not replay");
    },
    requestWorkspaceReadCancel: () => {
      cancels += 1;
    },
  } as unknown as DeviceGatewaySession;
  const service = new DeviceGatewayWorkspaceReadService({
    sessions: { workspaceReadSession: () => ({ session, route }) },
    workers: { authorize() {} },
    verifier: { async verify() {} },
    store,
  });
  const result = await service.cancel(
    worker,
    intent,
    reference(accepted.receiptId),
  );
  assert.deepEqual(
    { status: result.status, receiptId: result.receiptId },
    { status: "unknownOutcome", receiptId: accepted.receiptId },
  );
  assert.equal(executions, 0);
  assert.equal(cancels, 1);
});

test("peer route accepts heartbeat lease extension without weakening its epoch fence", () => {
  const renewed = { ...route, leaseExpiresAt: "2026-08-08T00:02:00Z" };
  assert.equal(sameWorkspaceReadPeerRoute(renewed, route), true);
  assert.equal(
    sameWorkspaceReadPeerRoute({ ...renewed, connectionEpoch: 8 }, route),
    false,
  );
  assert.equal(
    sameWorkspaceReadPeerRoute({ ...renewed, connectionId: "other" }, route),
    false,
  );
});

test("peer route validation fails closed on an invalid Gateway clock", () => {
  assert.throws(
    () => workspaceReadPeerNow(new Date(Number.NaN)),
    /workspace_read_clock_invalid/,
  );
});

test("workspace read peer client uses real loopback TLS 1.3 and bounded correlation", async (context) => {
  const server = createServer(serverTls(), async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const body = JSON.stringify({
      schemaVersion: "crewon.device-filesystem-read-peer-dispatch-response.v0",
      apiVersion: 1,
      route: input.route,
      operation: input.operation,
      resolution: {
        status: "unknownOutcome",
        executionId: command.executionId,
        receiptId: null,
        terminal: null,
      },
    });
    response.writeHead(200, {
      "content-length": Buffer.byteLength(body),
      "content-type": "application/json; charset=utf-8",
    });
    response.end(body);
  });
  const port = await listen(server);
  context.after(() => closeServer(server));
  const client = clientFor(port, "gateway-a");
  context.after(() => client.close());
  const resolution = await client.dispatchRead(
    { ...route, gatewayId: "gateway-2" },
    "execute",
    command,
    { workerId: "worker-1", credentialId: "credential-1" },
    new AbortController().signal,
  );
  assert.deepEqual(resolution, {
    status: "unknownOutcome",
    executionId: command.executionId,
    receiptId: null,
    terminal: null,
  });
});

const worker = {
  workerId: "worker-1",
  credentialId: "credential-1",
  authenticationMethod: "mtls" as const,
  authenticatedAt: "2026-08-08T00:00:00Z",
};
function reference(receiptId: string | null) {
  return {
    deviceId: command.deviceId,
    executionId: command.executionId,
    workspaceBindingId: command.workspaceBindingId,
    incarnationId: command.arguments.workspaceIncarnationId,
    ...intent,
    actionDigest: command.actionDigest,
    commandDigest: canonicalDeviceFilesystemReadCommandDigest(
      command,
      digestUtf8,
    ),
    leaseId: command.leaseId,
    leaseEpoch: command.leaseEpoch,
    receiptId,
  };
}
function digestUtf8(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
