import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { ModelTransportPort } from "@crewon/agent-kernel";
import {
  canonicalActionIntent,
  canonicalDeviceFilesystemReadCommandDigest,
  type ActionIntent,
  type DeviceFilesystemReadCommand,
  type DeviceFilesystemReadDispatchResolution,
} from "@crewon/contracts";
import { Ed25519DeviceCommandSigner } from "@crewon/device-dispatch";
import { SqliteRunStore } from "@crewon/store";
import type {
  ToolExecutionCommand,
  ToolExecutionPolicy,
} from "@crewon/tool-broker";

import { activateStandaloneRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";
import type { RuntimeWorkspaceReadGatewayClientPort } from "./runtime-workspace-read-gateway-client.ts";
import {
  createStandaloneRuntimeWorker,
  type RuntimeWorkerCompositionConfig,
} from "./standalone-composition.ts";

test("composes the released read_file Tool through durable SQLite authority", async (context) => {
  const databasePath = temporaryDatabasePath(context);
  const config = runtimeConfig();
  const closes = { listGateway: 0, readGateway: 0 };
  const received: DeviceFilesystemReadCommand[] = [];
  const readGateway = readGatewayOf(received, () => {
    closes.readGateway += 1;
  });
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const composition = {
    ...config,
    nativeWorkspaceReadCatalog: "enabled" as const,
    workspacePrivate: workspacePrivateConfig(() => {
      closes.listGateway += 1;
    }),
    workspaceReadFile: {
      signer: new Ed25519DeviceCommandSigner({
        keyId: "workspace-key-1",
        privateKey,
      }),
      gateway: readGateway,
    },
  };
  await activateRelease(databasePath, composition);
  await seedAuthority(databasePath);
  const runtime = await createStandaloneRuntimeWorker({
    ...composition,
    databasePath,
    scanIntervalMs: null,
  });

  const active = runtime.agentVersionRegistry.resolve({
    tenantId: config.runtimeTenantId,
    agentVersionId: config.route.agentVersionId,
  });
  assert.ok(active !== null);
  assert.deepEqual(active.toolRuntime.definitions(), runtime.agentVersion.tools);
  assert.deepEqual(
    active.toolRuntime.definitions().map(({ kind, name }) => `${kind}:${name}`),
    ["function:read_file"],
  );
  const policy = active.toolRuntime.executionPolicy("function", "read_file");
  assert.ok(policy !== null);
  const command = toolCommand(policy);
  const first = await active.toolRuntime.execute(command, signal());
  const replay = await active.toolRuntime.execute(command, signal());

  assert.deepEqual(first, {
    status: "completed",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: "call-1",
      output: "hello from workspace\n",
      isError: false,
      artifactRef: null,
    },
  });
  assert.deepEqual(replay, first);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0]?.arguments.relativePathSegments, [
    "docs",
    "README.md",
  ]);
  assert.equal(received[0]?.authorization.keyId, "workspace-key-1");

  await runtime.close();
  await runtime.close();
  assert.deepEqual(closes, { listGateway: 1, readGateway: 1 });
});

test("fails closed and releases Gateways when native read composition is incomplete", async (context) => {
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const cases = [
    {
      name: "catalog without read execution",
      config: (closed: () => void) => ({
        ...runtimeConfig(),
        nativeWorkspaceReadCatalog: "enabled" as const,
        workspacePrivate: workspacePrivateConfig(closed),
      }),
    },
    {
      name: "read execution without catalog",
      config: (closed: () => void) => ({
        ...runtimeConfig(),
        nativeWorkspaceReadCatalog: "disabled" as const,
        workspacePrivate: workspacePrivateConfig(() => {}),
        workspaceReadFile: {
          signer: new Ed25519DeviceCommandSigner({
            keyId: "workspace-key-1",
            privateKey,
          }),
          gateway: readGatewayOf([], closed),
        },
      }),
    },
    {
      name: "read execution without deployment authority",
      config: (closed: () => void) => ({
        ...runtimeConfig(),
        nativeWorkspaceReadCatalog: "enabled" as const,
        workspaceReadFile: {
          signer: new Ed25519DeviceCommandSigner({
            keyId: "workspace-key-1",
            privateKey,
          }),
          gateway: readGatewayOf([], closed),
        },
      }),
    },
  ];

  for (const entry of cases) {
    let closes = 0;
    await assert.rejects(
      createStandaloneRuntimeWorker({
        ...entry.config(() => {
          closes += 1;
        }),
        databasePath: temporaryDatabasePath(context),
        scanIntervalMs: null,
      }),
      new Error("runtime_workspace_read_configuration_incomplete"),
      entry.name,
    );
    assert.equal(closes, 1, entry.name);
  }
});

function runtimeConfig(): RuntimeWorkerCompositionConfig {
  return {
    runtimeTenantId: "tenant-1",
    route: {
      authorityId: "authority-1",
      runtimeGeneration: "runtime-binding-1",
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

function workspacePrivateConfig(closed: () => void) {
  return {
    port: 0,
    token: "runtime-worker-private-workspace-token-32-bytes",
    authority: {
      tenantId: "tenant-1",
      spaceId: "space-1",
      workspaceBindingId: "workspace-1",
      incarnationId: "incarnation-1",
      deviceBindingId: "device-binding-1",
      deviceId: "device-1",
      runtimeBindingId: "runtime-binding-1",
      policySnapshotId: "policy-1",
    },
    ids: { nextExecutionId: () => "workspace-list-execution-1" },
    signer: { sign: async () => assert.fail("list signing not expected") },
    gateway: {
      execute: async () => assert.fail("list execute not expected"),
      reconcile: async () => assert.fail("list reconcile not expected"),
      cancel: async () => assert.fail("list cancel not expected"),
      close: async () => closed(),
    },
  };
}

function readGatewayOf(
  received: DeviceFilesystemReadCommand[],
  closed: () => void,
): RuntimeWorkspaceReadGatewayClientPort {
  return {
    async execute(routeIntent, command) {
      assert.deepEqual(routeIntent, {
        deviceBindingId: "device-binding-1",
        runtimeBindingId: "runtime-binding-1",
      });
      received.push(structuredClone(command));
      return completed(command);
    },
    async reconcile() {
      return assert.fail("reconcile not expected");
    },
    async cancel() {
      return assert.fail("cancel not expected");
    },
    async close() {
      closed();
    },
  };
}

function toolCommand(policy: ToolExecutionPolicy): ToolExecutionCommand {
  const input = JSON.stringify({ path: "docs/README.md" });
  const actionIntent: ActionIntent = {
    schemaVersion: "crewon.action-intent.v0",
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    tool: { kind: "function", name: "read_file", inputDigest: sha256(input) },
    effect: policy.effect,
    recovery: policy.recovery,
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
    resourceBindingId: policy.resourceBindingId,
    credentialBindingId: policy.credentialBindingId,
    executionTarget: policy.executionTarget,
    capability: policy.capability,
    approvalRequirement: policy.approvalRequirement,
    limits: policy.limits,
  };
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    idempotencyKey: "tool-read-idempotency-1",
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    kind: "function",
    name: "read_file",
    input,
    executionId: "execution-1",
    executionLease: {
      workItemId: "work-item-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    actionDigest: sha256(canonicalActionIntent(actionIntent)),
    actionIntent,
    approvalProof: null,
  };
}

function completed(
  command: DeviceFilesystemReadCommand,
): DeviceFilesystemReadDispatchResolution {
  const content = "hello from workspace\n";
  return {
    status: "completed",
    executionId: command.executionId,
    receiptId: "receipt-1",
    terminal: {
      schemaVersion: "crewon.device-filesystem-read-event.v0",
      protocolVersion: 1,
      commandKind: "workspaceRead",
      deviceId: command.deviceId,
      executionId: command.executionId,
      receiptId: "receipt-1",
      connectionEpoch: 1,
      workspaceBindingId: command.workspaceBindingId,
      incarnationId: command.arguments.workspaceIncarnationId,
      commandDigest: canonicalDeviceFilesystemReadCommandDigest(
        command,
        sha256,
      ),
      sequence: 2,
      observedAt: new Date().toISOString(),
      type: "workspace_read.completed",
      data: {
        result: {
          schemaVersion: "crewon.workspace-file-read-result.v0",
          encoding: "utf8",
          content,
          byteLength: Buffer.byteLength(content, "utf8"),
          outputDigest: sha256(content),
        },
      },
    },
  };
}

async function seedAuthority(databasePath: string): Promise<void> {
  const store = new SqliteRunStore(databasePath);
  const occurredAt = new Date().toISOString();
  await store.commitThread({
    tenantId: "tenant-1",
    idempotency: {
      scope: "workspace-read-composition",
      key: "thread-create-1",
      requestFingerprint: "thread-create-fingerprint-1",
    },
    expectedRevision: 0,
    events: [
      {
        schemaVersion: "crewon.thread-event.v0",
        identity: { threadId: "thread-1" },
        eventId: "thread-event-1",
        sequence: 1,
        occurredAt,
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
  await store.commitRun({
    tenantId: "tenant-1",
    idempotency: {
      scope: "workspace-read-composition",
      key: "run-create-1",
      requestFingerprint: "run-create-fingerprint-1",
    },
    expectedRevision: 0,
    events: [
      {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: "run-1" },
        eventId: "run-event-1",
        sequence: 1,
        occurredAt,
        type: "run.created",
        data: {
          threadId: "thread-1",
          tenantId: "tenant-1",
          spaceId: "space-1",
          createdByActorId: "actor-1",
          authorityId: "authority-1",
          runtimeGeneration: "runtime-binding-1",
          agentVersionId: "agent-version-1",
          policySnapshotId: "policy-1",
          workspaceBindingId: "workspace-1",
          collaborationMode: "default",
          origin: null,
          goalBinding: null,
        },
      },
      {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: "run-1" },
        eventId: "run-event-2",
        sequence: 2,
        occurredAt,
        type: "run.started",
        data: {},
      },
    ],
    outbox: [],
    workItems: [],
  });
  await store.close();
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
    activationId: "activation-workspace-read-composition",
  });
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

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function temporaryDatabasePath(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "crewon-workspace-read-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "control.sqlite");
}
