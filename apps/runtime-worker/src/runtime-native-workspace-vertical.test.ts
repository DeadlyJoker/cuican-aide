import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import test, { type TestContext } from "node:test";

import type { ModelTransportPort } from "@crewon/agent-kernel";
import type { RuntimeWorkerCompositionConfig } from "./standalone-composition.ts";
import {
  DEVICE_GATEWAY_WORKER_WORKSPACE_LIST_DISPATCH_PATH,
  RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH,
  RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH,
  parseDeviceWorkspaceListWorkerDispatchRequest,
  parseRuntimeWorkerWorkspaceDispatchResponse,
  parseRuntimeWorkerWorkspaceFreezeCommandResponse,
  type DeviceWorkspaceListCommand,
  type DeviceWorkspaceListWorkerDispatchResponse,
  type RuntimeWorkerWorkspaceDispatchRequest,
  type RuntimeWorkerFrozenWorkspaceCommand,
  type RuntimeWorkerWorkspaceFreezeCommandRequest,
} from "@crewon/contracts";
import { SqliteRunStore } from "@crewon/store";

import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
  TEST_WORKER_CERT,
  TEST_WORKER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import { activateStandaloneRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";
import type { RuntimeNativeWorkspaceBootstrap } from "./runtime-native-bootstrap.ts";
import { createRuntimeNativeWorkspaceResources } from "./runtime-native-workspace.ts";
import { createStandaloneRuntimeWorker } from "./standalone-composition.ts";
import { StoreBackedRuntimeWorkspaceAuthority } from "./runtime-workspace-binding-resolver.ts";

test("runs SQLite Thread freeze through private loopback and real mTLS Gateway", async (context) => {
  const gateway = await startGateway(context);
  const databasePath = temporaryDatabasePath(context);
  const config = runtimeConfig();
  await activateRelease(databasePath, config);
  await seedThread(databasePath);
  const commandKey = generateKeyPairSync("ed25519");
  const native = createRuntimeNativeWorkspaceResources({
    bootstrap: workspaceBootstrap(
      gateway.origin,
      commandKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ),
    runtimeTenantId: config.runtimeTenantId,
    route: config.route,
  });
  const runtime = await createStandaloneRuntimeWorker({
    ...config,
    databasePath,
    scanIntervalMs: null,
    workspacePrivate: native.config,
  });
  context.after(() => runtime.close());
  assert.match(
    runtime.workspacePrivateOrigin ?? "",
    /^http:\/\/127\.0\.0\.1:\d+$/u,
  );

  const freezeRequest = workspaceFreezeRequest();
  const freeze = parseRuntimeWorkerWorkspaceFreezeCommandResponse(
    await post(
      runtime.workspacePrivateOrigin!,
      RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH,
      freezeRequest,
    ),
    freezeRequest,
  );
  assert.deepEqual(
    {
      workspaceBindingId: freeze.command.workspaceBindingId,
      incarnationId: freeze.command.incarnationId,
      deviceId: freeze.command.deviceId,
      runtimeBindingId: freeze.command.runtimeBindingId,
    },
    {
      workspaceBindingId: "workspace-1",
      incarnationId: "incarnation-1",
      deviceId: "device-1",
      runtimeBindingId: "runtime-generation-1",
    },
  );

  const dispatchRequest = workspaceDispatchRequest(freeze.command);
  const dispatch = parseRuntimeWorkerWorkspaceDispatchResponse(
    await post(
      runtime.workspacePrivateOrigin!,
      RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH,
      dispatchRequest,
    ),
    dispatchRequest,
  );
  assert.equal(dispatch.resolution.status, "completed");
  assert.deepEqual(dispatch.resolution, {
    status: "completed",
    executionId: freeze.command.executionId,
    actionDigest: freeze.command.actionDigest,
    commandDigest: freeze.command.commandDigest,
    providerReceiptId: "gateway-receipt-1",
    entries: [{ name: "README.md", kind: "file" }],
    truncated: false,
  });
  assert.equal(gateway.received.length, 1);
  assert.equal(gateway.received[0]?.authorization.keyId, "workspace-key-1");
  await runtime.close();
  await runtime.close();
});

test("real SQLite resolver fences wrong space, revision, and deleted Thread", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  await seedThread(databasePath);
  const store = new SqliteRunStore(databasePath);
  const resolver = new StoreBackedRuntimeWorkspaceAuthority({
    store,
    authority: staticAuthority(),
  });
  const query = {
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    principalId: "principal-1",
    actorId: "actor-1",
  };
  assert.ok(await resolver.resolve(query, new AbortController().signal));
  assert.equal(
    await resolver.resolve(
      { ...query, spaceId: "space-other" },
      new AbortController().signal,
    ),
    null,
  );
  assert.equal(
    await resolver.resolve(
      { ...query, expectedThreadRevision: 2 },
      new AbortController().signal,
    ),
    null,
  );
  await store.commitThread({
    tenantId: "tenant-1",
    idempotency: {
      scope: "native-workspace-vertical",
      key: "thread-delete-1",
      requestFingerprint: "native-workspace-thread-delete-v1",
    },
    expectedRevision: 1,
    events: [
      {
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: "thread-1" },
        eventId: "thread-event-2",
        sequence: 2,
        occurredAt: new Date().toISOString(),
        type: "thread.deleted",
        data: { actorId: "actor-1" },
      },
    ],
    messages: [],
    history: { expectedLastSequence: 0, items: [] },
    tombstone: {
      expectedActiveRunId: null,
      expectedGoalRevision: null,
      occurredAt: new Date().toISOString(),
    },
  });
  assert.equal(
    await resolver.resolve(
      { ...query, expectedThreadRevision: 2 },
      new AbortController().signal,
    ),
    null,
  );
  await store.close();
});

async function startGateway(context: TestContext): Promise<{
  origin: string;
  received: DeviceWorkspaceListCommand[];
}> {
  const received: DeviceWorkspaceListCommand[] = [];
  const server = createServer(
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
        assert.ok(request.socket instanceof TLSSocket);
        assert.equal(request.socket.authorized, true);
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const input = parseDeviceWorkspaceListWorkerDispatchRequest(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        if (input.operation !== "execute") {
          return assert.fail("execute expected");
        }
        received.push(input.command);
        const body: DeviceWorkspaceListWorkerDispatchResponse = {
          schemaVersion: "crewon.device-workspace-list-dispatch-response.v0",
          apiVersion: 1,
          operation: "execute",
          resolution: completed(input.command),
        };
        const encoded = Buffer.from(JSON.stringify(body));
        response.writeHead(200, {
          "content-length": String(encoded.byteLength),
          "content-type": "application/json; charset=utf-8",
        });
        response.end(encoded);
      })().catch((error: unknown) => response.destroy(error as Error));
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return { origin: `https://127.0.0.1:${address.port}`, received };
}

async function post(
  origin: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${WORKSPACE_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function seedThread(databasePath: string): Promise<void> {
  const store = new SqliteRunStore(databasePath);
  await store.commitThread({
    tenantId: "tenant-1",
    idempotency: {
      scope: "native-workspace-vertical",
      key: "thread-create-1",
      requestFingerprint: "native-workspace-thread-v1",
    },
    expectedRevision: 0,
    events: [
      {
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: "thread-1" },
        eventId: "thread-event-1",
        sequence: 1,
        occurredAt: new Date().toISOString(),
        type: "thread.created",
        data: {
          tenantId: "tenant-1",
          spaceId: "space-1",
          createdByActorId: "actor-1",
          title: null,
        },
      },
    ],
    messages: [],
    history: { expectedLastSequence: 0, items: [] },
  });
  await store.close();
}

function workspaceFreezeRequest(): RuntimeWorkerWorkspaceFreezeCommandRequest {
  return {
    schemaVersion: "crewon.runtime-worker-workspace-freeze-request.v0",
    apiVersion: 1,
    tenantId: "tenant-1",
    spaceId: "space-1",
    actor: { principalId: "principal-1", actorId: "actor-1" },
    threadFence: { threadId: "thread-1", expectedRevision: 1 },
    idempotencyKey: "workspace-idempotency-1",
    maxEntries: 5,
  };
}

function workspaceDispatchRequest(
  command: RuntimeWorkerFrozenWorkspaceCommand,
): RuntimeWorkerWorkspaceDispatchRequest {
  const now = Date.now();
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
      leaseId: "delivery-execute-1",
      epoch: 1,
      leasedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 35_000).toISOString(),
    },
  };
}

function completed(command: DeviceWorkspaceListCommand) {
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
      observedAt: new Date().toISOString(),
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

function workspaceBootstrap(
  endpoint: string,
  signingPrivateKeyPem: string,
): RuntimeNativeWorkspaceBootstrap {
  return {
    privateServer: { port: 0, token: WORKSPACE_TOKEN },
    authority: staticAuthority(),
    signing: { keyId: "workspace-key-1", privateKeyPem: signingPrivateKeyPem },
    gateway: {
      endpoint,
      deadlineMs: 35_000,
      tls: {
        keyPem: TEST_WORKER_KEY,
        certificatePem: TEST_WORKER_CERT,
        caCertificatePem: TEST_CA_CERT,
        servername: "localhost",
      },
    },
  };
}

function staticAuthority(): RuntimeNativeWorkspaceBootstrap["authority"] {
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    workspaceBindingId: "workspace-1",
    incarnationId: "incarnation-1",
    deviceBindingId: "device-binding-1",
    deviceId: "device-1",
    runtimeBindingId: "runtime-generation-1",
    policySnapshotId: "policy-1",
  };
}

function runtimeConfig(): RuntimeWorkerCompositionConfig {
  return {
    runtimeTenantId: "tenant-1",
    route: {
      authorityId: "authority-1",
      runtimeGeneration: "runtime-generation-1",
      agentVersionId: "agent-version-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: "workspace-1",
    },
    transport: fakeTransport(),
    agentInstructions: "stable instructions",
    streamMaxRetries: 1,
    maxToolRounds: 1,
    autoCompactAtTokens: 96_000,
    modelContextWindowTokens: 128_000,
  };
}

function fakeTransport(): ModelTransportPort {
  return {
    adapterName: "fake-adapter",
    adapterVersion: "1",
    modelId: "fake-model",
    async *stream() {
      yield { type: "completed", checkpoint: null };
    },
  };
}

async function activateRelease(
  databasePath: string,
  config: RuntimeWorkerCompositionConfig,
): Promise<void> {
  await activateStandaloneRuntimeAgentVersionRelease({
    ...config,
    databasePath,
    actor: {
      principalId: "release-principal",
      actorId: "release-actor",
      tenantId: config.runtimeTenantId,
      spaceId: "space-1",
    },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => new Date().toISOString() },
    activationId: "activation-native-workspace",
  });
}

function temporaryDatabasePath(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "crewon-native-workspace-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "control.sqlite");
}

const WORKSPACE_TOKEN = "workspace-private-token-at-least-32-bytes";
