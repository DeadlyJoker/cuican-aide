import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { ModelTransportPort } from "@crewon/agent-kernel";
import type { RuntimeWorkerCompositionConfig } from "./standalone-composition.ts";
import {
  RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH,
  RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH,
  parseRuntimeWorkerWorkspaceDispatchResponse,
  parseRuntimeWorkerWorkspaceFreezeCommandResponse,
  type RuntimeWorkerWorkspaceDispatchRequest,
  type RuntimeWorkerFrozenWorkspaceCommand,
  type RuntimeWorkerWorkspaceFreezeCommandRequest,
} from "@crewon/contracts";
import { SqliteRunStore } from "@crewon/store";

import { activateStandaloneRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";
import type { RuntimeNativeWorkspaceBootstrap } from "./runtime-native-bootstrap.ts";
import { createRuntimeNativeWorkspaceResources } from "./runtime-native-workspace.ts";
import { createStandaloneRuntimeWorker } from "./standalone-composition.ts";
import { StoreBackedRuntimeWorkspaceAuthority } from "./runtime-workspace-binding-resolver.ts";

test("runs SQLite Thread freeze through private loopback and local TS Workspace", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "crewon-local-workspace-"));
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(join(workspace, "README.md"), "local workspace"),
  );
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  const databasePath = temporaryDatabasePath(context);
  const config = runtimeConfig();
  await activateRelease(databasePath, config);
  await seedThread(databasePath);
  const commandKey = generateKeyPairSync("ed25519");
  const native = createRuntimeNativeWorkspaceResources({
    bootstrap: workspaceBootstrap(
      workspace,
      commandKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ),
    runtimeTenantId: config.runtimeTenantId,
    route: config.route,
  });
  const runtime = await createStandaloneRuntimeWorker({
    ...config,
    databasePath,
    scanIntervalMs: null,
    workspaceReadFile: native.readFile,
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
    providerReceiptId: `local-list:${freeze.command.executionId}`,
    entries: [{ name: "README.md", kind: "file" }],
    truncated: false,
  });
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

function workspaceBootstrap(
  trustedLocalPath: string,
  signingPrivateKeyPem: string,
): RuntimeNativeWorkspaceBootstrap {
  return {
    dispatchMode: "local",
    trustedLocalPath,
    privateServer: { port: 0, token: WORKSPACE_TOKEN },
    authority: staticAuthority(),
    signing: { keyId: "workspace-key-1", privateKeyPem: signingPrivateKeyPem },
    gateway: {
      endpoint: "https://127.0.0.1:443",
      deadlineMs: 35_000,
      tls: {
        keyPem: signingPrivateKeyPem,
        certificatePem: "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----",
        caCertificatePem: "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----",
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
    nativeWorkspaceReadCatalog: "enabled",
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
