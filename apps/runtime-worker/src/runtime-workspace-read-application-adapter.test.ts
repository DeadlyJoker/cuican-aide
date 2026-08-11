import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  WorkspaceReadFileApplicationService,
  WorkspaceReadFileDispatchError,
  type WorkspaceReadFileExecuteIntent,
} from "@crewon/application";
import {
  canonicalActionIntent,
  canonicalDeviceFilesystemReadCommandDigest,
  type ActionIntent,
  type DeviceFilesystemReadCommand,
  type DeviceFilesystemReadDispatchResolution,
  type DeviceFilesystemReadEvent,
} from "@crewon/contracts";
import type { RunState, ThreadState } from "@crewon/domain";
import { InMemoryWorkspaceReadFileStore } from "@crewon/store";
import {
  ToolBrokerError,
  type ToolExecutionCommand,
} from "@crewon/tool-broker";

import {
  RuntimeWorkspaceReadApplicationAdapter,
  type RuntimeWorkspaceReadAuthorityStorePort,
} from "./runtime-workspace-read-application-adapter.ts";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";

test("executes after current Run/Thread authority and replays without rereading it", async () => {
  const fixture = fixtureOf();
  const first = await fixture.adapter.execute(
    fixture.command,
    ["README.md"],
    signal(),
  );
  fixture.authority.failReads = true;
  const replay = await fixture.adapter.execute(
    fixture.command,
    ["README.md"],
    signal(),
  );

  assert.deepEqual(first, completedToolResolution());
  assert.deepEqual(replay, first);
  assert.deepEqual(fixture.calls, {
    commandAuthorities: [
      {
        threadId: "thread-1",
        expectedThreadRevision: 7,
        principalId: "actor-1",
        actorId: "actor-1",
        leaseId: "lease-1",
        leaseEpoch: 4,
      },
    ],
    executes: 1,
    reconciles: 0,
    cancels: 0,
    runReads: 1,
    threadReads: 1,
  });
});

test("possibly-sent execute is fenced and only passive reconcile settles it", async () => {
  let failExecute = true;
  const fixture = fixtureOf({
    execute: async () => {
      fixture.calls.executes += 1;
      if (failExecute)
        throw Object.assign(new Error("socket closed after write"), {
          certainty: "possiblySent",
        });
      return completedDispatch();
    },
  });
  await assert.rejects(
    fixture.adapter.execute(fixture.command, ["README.md"], signal()),
    WorkspaceReadFileDispatchError,
  );
  fixture.authority.failReads = true;
  failExecute = false;

  assert.deepEqual(
    await fixture.adapter.execute(
      fixture.command,
      ["README.md"],
      signal(),
    ),
    {
      status: "unknownOutcome",
      executionId: "execution-1",
      providerReceiptId: null,
    },
  );
  assert.deepEqual(
    await fixture.adapter.reconcile(
      {
        ...fixture.command,
        executionLease: {
          ...fixture.command.executionLease,
          leaseId: "lease-recovery-2",
          leaseEpoch: 5,
          expiresAt: "2026-08-12T16:05:00.000Z",
        },
      },
      ["README.md"],
      signal(),
    ),
    completedToolResolution(),
  );
  assert.deepEqual(fixture.calls, {
    commandAuthorities: [
      {
        threadId: "thread-1",
        expectedThreadRevision: 7,
        principalId: "actor-1",
        actorId: "actor-1",
        leaseId: "lease-1",
        leaseEpoch: 4,
      },
    ],
    executes: 1,
    reconciles: 1,
    cancels: 0,
    runReads: 1,
    threadReads: 1,
  });
});

test("projects exact Device failures and passive cancellation", async () => {
  const failed = fixtureOf({
    execute: async () => {
      failed.calls.executes += 1;
      return failedDispatch();
    },
  });
  assert.deepEqual(
    await failed.adapter.execute(failed.command, ["README.md"], signal()),
    {
      status: "failed",
      executionId: "execution-1",
      providerReceiptId: "receipt-1",
      code: "workspace_read_not_found",
      retryable: false,
    },
  );

  const canceled = fixtureOf({
    execute: async () => {
      canceled.calls.executes += 1;
      throw Object.assign(new Error("sent before cancellation"), {
        certainty: "possiblySent",
      });
    },
    cancel: async () => {
      canceled.calls.cancels += 1;
      return canceledDispatch();
    },
  });
  await assert.rejects(
    canceled.adapter.execute(canceled.command, ["README.md"], signal()),
    WorkspaceReadFileDispatchError,
  );
  canceled.authority.failReads = true;
  assert.deepEqual(
    await canceled.adapter.cancel(
      canceled.command,
      ["README.md"],
      signal(),
    ),
    {
      status: "canceled",
      executionId: "execution-1",
      providerReceiptId: "receipt-1",
    },
  );
  assert.deepEqual(
    { executes: canceled.calls.executes, cancels: canceled.calls.cancels },
    { executes: 1, cancels: 1 },
  );
});

test("fails closed before signing when durable Run deployment drifts", async () => {
  const fixture = fixtureOf();
  fixture.authority.run = {
    ...fixture.authority.run,
    runtimeGeneration: "runtime-binding-drift",
  };

  await assert.rejects(
    fixture.adapter.execute(fixture.command, ["README.md"], signal()),
    (error) =>
      error instanceof ToolBrokerError &&
      error.code === "workspace_read_run_authority_unavailable",
  );
  assert.equal(fixture.calls.executes, 0);
  assert.deepEqual(fixture.calls.commandAuthorities, []);
});

function fixtureOf(overrides: {
  execute?: () => Promise<DeviceFilesystemReadDispatchResolution>;
  reconcile?: () => Promise<DeviceFilesystemReadDispatchResolution>;
  cancel?: () => Promise<DeviceFilesystemReadDispatchResolution>;
} = {}) {
  const command = toolCommand();
  const calls = {
    commandAuthorities: [] as Array<
      Pick<
        WorkspaceReadFileExecuteIntent,
        | "threadId"
        | "expectedThreadRevision"
        | "principalId"
        | "actorId"
        | "leaseId"
        | "leaseEpoch"
      >
    >,
    executes: 0,
    reconciles: 0,
    cancels: 0,
    runReads: 0,
    threadReads: 0,
  };
  const authority = authorityStore(calls);
  const store = new InMemoryWorkspaceReadFileStore();
  const application = new WorkspaceReadFileApplicationService({
    store,
    commands: {
      async create(intent) {
        calls.commandAuthorities.push({
          threadId: intent.threadId,
          expectedThreadRevision: intent.expectedThreadRevision,
          principalId: intent.principalId,
          actorId: intent.actorId,
          leaseId: intent.leaseId,
          leaseEpoch: intent.leaseEpoch,
        });
        return frozenCommand(command, intent.relativePathSegments);
      },
    },
    gateway: {
      execute:
        overrides.execute ??
        (async () => {
          calls.executes += 1;
          return completedDispatch();
        }),
      reconcile:
        overrides.reconcile ??
        (async () => {
          calls.reconciles += 1;
          return completedDispatch();
        }),
      cancel:
        overrides.cancel ??
        (async () => {
          calls.cancels += 1;
          return canceledDispatch();
        }),
    },
  });
  return {
    adapter: new RuntimeWorkspaceReadApplicationAdapter({
      application,
      store: authority,
      deployment: deployment(),
      digester: new NodeSha256ContentDigester(),
    }),
    authority,
    calls,
    command,
  };
}

function authorityStore(calls: {
  runReads: number;
  threadReads: number;
}): RuntimeWorkspaceReadAuthorityStorePort & {
  run: RunState;
  thread: ThreadState;
  failReads: boolean;
} {
  return {
    run: runState(),
    thread: threadState(),
    failReads: false,
    async loadRun() {
      calls.runReads += 1;
      if (this.failReads) throw new Error("mutable Run read forbidden");
      return structuredClone(this.run);
    },
    async loadThreadInSpace() {
      calls.threadReads += 1;
      if (this.failReads) throw new Error("mutable Thread read forbidden");
      return structuredClone(this.thread);
    },
  };
}

function toolCommand(): ToolExecutionCommand {
  const input = JSON.stringify({ path: "README.md" });
  const actionIntent: ActionIntent = {
    schemaVersion: "crewon.action-intent.v0",
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    tool: { kind: "function", name: "read_file", inputDigest: sha256(input) },
    effect: "readOnly",
    recovery: "reconcilable",
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
    resourceBindingId: "workspace-1",
    credentialBindingId: null,
    executionTarget: { kind: "device", bindingId: "device-binding-1" },
    capability: "workspace.read_file.v0",
    approvalRequirement: "none",
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
      maxArtifactBytes: 16_777_216,
    },
  };
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    idempotencyKey: "tool read idempotency",
    runId: actionIntent.runId,
    segmentId: actionIntent.segmentId,
    callId: actionIntent.callId,
    kind: "function",
    name: "read_file",
    input,
    executionId: "execution-1",
    executionLease: {
      workItemId: "work-item-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      leaseId: "lease-1",
      leaseEpoch: 4,
      expiresAt: "2026-08-12T16:00:00.000Z",
    },
    actionDigest: sha256(canonicalActionIntent(actionIntent)),
    actionIntent,
    approvalProof: null,
  };
}

function frozenCommand(
  tool: ToolExecutionCommand,
  relativePathSegments: readonly string[],
) {
  const command = {
    schemaVersion: "crewon.device-command.v0",
    protocolVersion: 1,
    deviceId: "device-1",
    leaseId: tool.executionLease.leaseId,
    leaseEpoch: tool.executionLease.leaseEpoch,
    expiresAt: tool.executionLease.expiresAt,
    runId: tool.runId,
    stepId: tool.executionLease.stepId,
    attemptId: tool.executionLease.attemptId,
    executionId: tool.executionId,
    workspaceBindingId: "workspace-1",
    capability: "workspace.read_file.v0",
    actionDigest: sha256("device-action"),
    arguments: {
      schemaVersion: "crewon.device-filesystem-read-arguments.v0",
      workspaceIncarnationId: "incarnation-1",
      relativePathSegments: [...relativePathSegments],
      encoding: "utf8",
    },
    payloadRef: null,
    limits: tool.actionIntent.limits,
    idempotencyKey: `workspace-read:${"a".repeat(64)}`,
    traceContext: { traceparent: null, tracestate: null },
    authorization: {
      schemaVersion: "crewon.device-authorization.v0",
      scheme: "ed25519",
      keyId: "key-1",
      issuedAt: "2026-08-12T15:00:00.000Z",
      expiresAt: "2026-08-12T15:30:00.000Z",
      approvalProof: null,
      signature: "A".repeat(86),
    },
  } as DeviceFilesystemReadCommand;
  return {
    command,
    routeIntent: {
      deviceBindingId: "device-binding-1",
      runtimeBindingId: "runtime-binding-1",
    },
    reference: {
      deviceId: command.deviceId,
      executionId: command.executionId,
      workspaceBindingId: command.workspaceBindingId,
      incarnationId: command.arguments.workspaceIncarnationId,
      deviceBindingId: "device-binding-1",
      runtimeBindingId: "runtime-binding-1",
      actionDigest: command.actionDigest,
      commandDigest: canonicalDeviceFilesystemReadCommandDigest(
        command,
        sha256,
      ),
      leaseId: command.leaseId,
      leaseEpoch: command.leaseEpoch,
      receiptId: null,
    },
  };
}

function completedDispatch(): DeviceFilesystemReadDispatchResolution {
  return {
    status: "completed",
    executionId: "execution-1",
    receiptId: "receipt-1",
    terminal: terminalEvent("workspace_read.completed"),
  };
}

function failedDispatch(): DeviceFilesystemReadDispatchResolution {
  return {
    status: "failed",
    executionId: "execution-1",
    receiptId: "receipt-1",
    terminal: terminalEvent("workspace_read.failed"),
  };
}

function canceledDispatch(): DeviceFilesystemReadDispatchResolution {
  return {
    status: "canceled",
    executionId: "execution-1",
    receiptId: "receipt-1",
    terminal: terminalEvent("workspace_read.canceled"),
  };
}

function terminalEvent<T extends DeviceFilesystemReadEvent["type"]>(
  type: T,
): Extract<DeviceFilesystemReadEvent, { type: T }> {
  const command = frozenCommand(toolCommand(), ["README.md"]).command;
  const envelope = {
    schemaVersion: "crewon.device-filesystem-read-event.v0" as const,
    protocolVersion: 1 as const,
    commandKind: "workspaceRead" as const,
    deviceId: "device-1",
    executionId: "execution-1",
    receiptId: "receipt-1",
    connectionEpoch: 1,
    workspaceBindingId: "workspace-1",
    incarnationId: "incarnation-1",
    commandDigest: canonicalDeviceFilesystemReadCommandDigest(command, sha256),
    sequence: 2 as const,
    observedAt: "2026-08-12T15:01:00.000Z",
  };
  if (type === "workspace_read.completed")
    return {
      ...envelope,
      type,
      data: {
        result: {
          schemaVersion: "crewon.workspace-file-read-result.v0",
          encoding: "utf8",
          content: "hello 世界",
          byteLength: 12,
          outputDigest: sha256("hello 世界"),
        },
      },
    } as Extract<DeviceFilesystemReadEvent, { type: T }>;
  if (type === "workspace_read.failed")
    return {
      ...envelope,
      type,
      data: { code: "workspace_read_not_found", retryable: false },
    } as Extract<DeviceFilesystemReadEvent, { type: T }>;
  return {
    ...envelope,
    type: "workspace_read.canceled",
    data: { reasonCode: "caller_canceled" },
  } as Extract<DeviceFilesystemReadEvent, { type: T }>;
}

function completedToolResolution() {
  return {
    status: "completed" as const,
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    result: {
      schemaVersion: "crewon.workspace-file-read-result.v0" as const,
      encoding: "utf8" as const,
      content: "hello 世界",
      byteLength: 12,
    },
  };
}

function deployment() {
  return {
    tenantId: "tenant-1",
    spaceId: "space-1",
    workspaceBindingId: "workspace-1",
    incarnationId: "incarnation-1",
    deviceBindingId: "device-binding-1",
    deviceId: "device-1",
    runtimeBindingId: "runtime-binding-1",
    policySnapshotId: "policy-1",
  };
}

function runState(): RunState {
  return {
    runId: "run-1",
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
    purpose: "turn",
    origin: null,
    goalBinding: null,
    goalAccounting: null,
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 },
    status: "running",
    revision: 2,
    lastSequence: 2,
    cancelRequested: false,
    waitingApproval: null,
    suspensionReasonCode: null,
    reconciliationReceiptId: null,
    outputRef: null,
    failure: null,
    createdAt: "2026-08-12T15:00:00.000Z",
    updatedAt: "2026-08-12T15:00:01.000Z",
    terminalAt: null,
  };
}

function threadState(): ThreadState {
  return {
    threadId: "thread-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    createdByActorId: "actor-1",
    title: null,
    status: "active",
    revision: 7,
    lastEventSequence: 7,
    lastMessageSequence: 3,
    createdAt: "2026-08-12T15:00:00.000Z",
    updatedAt: "2026-08-12T15:00:02.000Z",
    archivedAt: null,
    deletedAt: null,
    deletedByActorId: null,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
function signal(): AbortSignal {
  return new AbortController().signal;
}
