import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:https";
import { TLSSocket } from "node:tls";
import test, { type TestContext } from "node:test";

import {
  DEVICE_GATEWAY_WORKER_WORKSPACE_LIST_DISPATCH_PATH,
  parseDeviceWorkspaceListWorkerDispatchRequest,
  type DeviceWorkspaceListCommand,
  type DeviceWorkspaceListWorkerDispatchResponse,
  type RuntimeWorkerWorkspaceDispatchRequest,
} from "@crewon/contracts";
import {
  Ed25519DeviceWorkspaceListCommandSigner,
  HttpsDeviceWorkspaceListDispatchClient,
} from "@crewon/device-dispatch";

import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
  TEST_WORKER_CERT,
  TEST_WORKER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";
import type { RuntimeWorkspaceBindingSnapshot } from "./runtime-workspace-binding-resolver.ts";
import { RuntimeWorkspaceDispatchService } from "./runtime-workspace-dispatch-service.ts";
import { RuntimeWorkspaceFreezeService } from "./runtime-workspace-freeze-service.ts";

const now = () => new Date("2026-08-10T00:00:30.000Z");

test("dispatches one frozen Workspace command over real loopback mTLS", async (context) => {
  const received: DeviceWorkspaceListCommand[] = [];
  const gateway = createServer(
    {
      key: TEST_SERVER_KEY,
      cert: TEST_SERVER_CERT,
      ca: TEST_CA_CERT,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    },
    (request, response) => {
      void (async () => {
        assert.equal(
          request.url,
          DEVICE_GATEWAY_WORKER_WORKSPACE_LIST_DISPATCH_PATH,
        );
        assert.equal(request.method, "POST");
        const socket = request.socket;
        assert.ok(socket instanceof TLSSocket);
        assert.equal(socket.authorized, true);
        assert.equal(
          socket.getPeerCertificate().subject.CN,
          "crewon-worker-test",
        );
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const input = parseDeviceWorkspaceListWorkerDispatchRequest(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        assert.equal(input.operation, "execute");
        if (input.operation !== "execute")
          return assert.fail("execute expected");
        received.push(input.command);
        const body: DeviceWorkspaceListWorkerDispatchResponse = {
          schemaVersion: "crewon.device-workspace-list-dispatch-response.v0",
          apiVersion: 1,
          operation: "execute",
          resolution: completedResolution(input.command),
        };
        const encoded = Buffer.from(JSON.stringify(body), "utf8");
        response.writeHead(200, {
          "content-length": String(encoded.byteLength),
          "content-type": "application/json; charset=utf-8",
        });
        response.end(encoded);
      })().catch((error: unknown) => response.destroy(error as Error));
    },
  );
  await new Promise<void>((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(0, "127.0.0.1", () => {
      gateway.off("error", reject);
      resolve();
    });
  });
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        gateway.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = gateway.address();
  assert.ok(address !== null && typeof address !== "string");

  const commandKeys = generateKeyPairSync("ed25519");
  const freeze = freezeService();
  const frozen = (
    await freeze.freeze(freezeRequest(), new AbortController().signal)
  ).command;
  const client = new HttpsDeviceWorkspaceListDispatchClient({
    endpoint: `https://127.0.0.1:${address.port}`,
    tls: {
      key: TEST_WORKER_KEY,
      cert: TEST_WORKER_CERT,
      ca: TEST_CA_CERT,
    },
    requestTimeoutMs: 5_000,
    now,
  });
  const service = new RuntimeWorkspaceDispatchService({
    authority: { admit: async (expected) => expected },
    digester: new NodeSha256ContentDigester(),
    signer: new Ed25519DeviceWorkspaceListCommandSigner({
      keyId: "workspace-key-1",
      privateKey: commandKeys.privateKey,
      now,
      authorizationTtlMs: 30_000,
    }),
    gateway: client,
    now,
  });
  context.after(() => service.close());

  const result = await service.dispatch(
    dispatchRequest(frozen),
    new AbortController().signal,
  );
  assert.equal(result.resolution.status, "completed");
  const receivedCommand = received[0];
  assert.ok(receivedCommand !== undefined);
  assert.deepEqual(receivedCommand, {
    ...receivedCommand,
    authorization: {
      ...receivedCommand.authorization,
      keyId: "workspace-key-1",
      issuedAt: "2026-08-10T00:00:30.000Z",
      expiresAt: "2026-08-10T00:01:00.000Z",
      approvalProof: null,
    },
  });
  assert.deepEqual(result.resolution, {
    status: "completed",
    executionId: frozen.executionId,
    actionDigest: frozen.actionDigest,
    commandDigest: frozen.commandDigest,
    providerReceiptId: "gateway-receipt-1",
    entries: [{ name: "README.md", kind: "file" }],
    truncated: false,
  });
});

function freezeService(): RuntimeWorkspaceFreezeService {
  return new RuntimeWorkspaceFreezeService({
    bindings: { resolve: async () => binding() },
    ids: { nextExecutionId: () => "workspace-execution-1" },
    digester: new NodeSha256ContentDigester(),
  });
}

function binding(): RuntimeWorkspaceBindingSnapshot {
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    principalId: "principal-1",
    actorId: "actor-1",
    workspaceBindingId: "workspace-1",
    incarnationId: "incarnation-1",
    deviceBindingId: "device-binding-1",
    deviceId: "device-1",
    runtimeBindingId: "runtime-binding-1",
    policySnapshotId: "policy-1",
  };
}

function freezeRequest() {
  return {
    schemaVersion: "crewon.runtime-worker-workspace-freeze-request.v0" as const,
    apiVersion: 1 as const,
    tenantId: "tenant-1",
    spaceId: "space-1",
    actor: { principalId: "principal-1", actorId: "actor-1" },
    threadFence: { threadId: "thread-1", expectedRevision: 1 },
    idempotencyKey: "workspace-idempotency-1",
    maxEntries: 5,
  };
}

function dispatchRequest(
  command: Awaited<
    ReturnType<RuntimeWorkspaceFreezeService["freeze"]>
  >["command"],
): RuntimeWorkerWorkspaceDispatchRequest {
  return {
    schemaVersion: "crewon.runtime-worker-workspace-dispatch-request.v0",
    apiVersion: 1,
    phase: "execute",
    operation: {
      schemaVersion: "crewon.workspace-operation.v0",
      tenantId: "tenant-1",
      spaceId: "space-1",
      threadId: "thread-1",
      expectedThreadRevision: 1,
      principalId: "principal-1",
      actorId: "actor-1",
      idempotencyKey: "workspace-idempotency-1",
      executionId: command.executionId,
      revision: 1,
      status: "prepared",
      command,
      resolution: null,
    },
    deliveryLease: {
      schemaVersion: "crewon.workspace-delivery-lease.v0",
      executionId: command.executionId,
      attemptNumber: 1,
      phase: "execute",
      ownerId: "runtime-worker-1",
      leaseId: "delivery-execute",
      epoch: 1,
      leasedAt: "2026-08-10T00:00:00.000Z",
      expiresAt: "2026-08-10T00:01:00.000Z",
    },
  };
}

function completedResolution(command: DeviceWorkspaceListCommand) {
  return {
    status: "completed" as const,
    executionId: command.executionId,
    receiptId: "gateway-receipt-1",
    terminal: {
      schemaVersion: "crewon.device-workspace-list-event.v0" as const,
      protocolVersion: 1 as const,
      commandKind: "workspaceList" as const,
      deviceId: command.deviceId,
      executionId: command.executionId,
      receiptId: "gateway-receipt-1",
      connectionEpoch: 1,
      workspaceBindingId: command.workspaceBindingId,
      incarnationId: command.incarnationId,
      deviceBindingId: command.deviceBindingId,
      runtimeBindingId: command.runtimeBindingId,
      actionDigest: command.actionDigest,
      commandDigest: command.commandDigest,
      sequence: 2,
      observedAt: "2026-08-10T00:00:31.000Z",
      type: "workspace_list.completed" as const,
      data: {
        result: {
          schemaVersion: "crewon.workspace-list-result.v0" as const,
          executionId: command.executionId,
          actionDigest: command.actionDigest,
          commandDigest: command.commandDigest,
          entries: [{ name: "README.md", kind: "file" as const }],
          truncated: false,
        },
      },
    },
  };
}
