import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  type DeviceFilesystemReadCommand,
  type DeviceFilesystemReadEvent,
} from "@crewon/contracts";
import type {
  FrozenWorkspaceReadFileDispatch,
  IdempotencyDescriptor,
  WorkspaceReadFileStore,
} from "@crewon/application";

import { InMemoryWorkspaceReadFileStore } from "./in-memory-workspace-read-file-store.ts";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkspaceReadFileStore } from "./sqlite-workspace-read-file-store.ts";

const fixture = JSON.parse(readFileSync(new URL(
  "../../test-contracts/fixtures/device-protocol.reference.json", import.meta.url,
), "utf8")) as { valid: {
  filesystemReadCommand: DeviceFilesystemReadCommand;
  filesystemReadEvents: readonly DeviceFilesystemReadEvent[];
} };

const command = fixture.valid.filesystemReadCommand;
const terminal = fixture.valid.filesystemReadEvents[1]!;
const locator = {
  tenantId: "tenant-1", spaceId: "space-1", runId: command.runId,
  stepId: command.stepId, attemptId: command.attemptId, executionId: command.executionId,
};
const executeIdempotency = idempotency("execute-key");

function conformance(name: string, create: () => WorkspaceReadFileStore) {
  test(`${name}: freezes before send and replays receipt before mutable authority`, async () => {
    const store = create();
    const first = await store.prepareWorkspaceReadFile({
      ...locator, idempotency: executeIdempotency, frozen: frozen(),
    });
    const replay = await store.loadWorkspaceReadFileReceipt({
      tenantId: locator.tenantId, spaceId: locator.spaceId,
      phase: "execute", idempotency: executeIdempotency,
    });
    assert.equal(first.operation.status, "prepared");
    assert.equal(first.operation.frozen.reference.receiptId, null);
    assert.deepEqual(replay?.operation, first.operation);
  });

  test(`${name}: possiblySent forbids blind execute and null receipt reconciles`, async () => {
    const store = create();
    const prepared = await store.prepareWorkspaceReadFile({
      ...locator, idempotency: executeIdempotency, frozen: frozen(),
    });
    const unknown = await store.markWorkspaceReadFilePossiblySent({
      ...locator, expectedRevision: prepared.operation.revision,
    });
    const replay = await store.prepareWorkspaceReadFile({
      ...locator, idempotency: executeIdempotency, frozen: frozen(),
    });
    assert.equal(unknown.status, "possiblySent");
    assert.equal(replay.operation.status, "possiblySent");
    const reconcileIdempotency = idempotency("reconcile-key");
    const action = await store.prepareWorkspaceReadFileAction({
      ...locator, phase: "reconcile", idempotency: reconcileIdempotency,
    });
    const committed = await store.commitWorkspaceReadFileResolution({
      ...locator, phase: "reconcile", idempotency: reconcileIdempotency,
      expectedRevision: action.operation.revision,
      resolution: completed(),
    });
    assert.equal(committed.operation.frozen.reference.receiptId, "receipt-read-1");
  });

  test(`${name}: exact terminal replays and receipt cannot drift`, async () => {
    const store = create();
    const prepared = await store.prepareWorkspaceReadFile({
      ...locator, idempotency: executeIdempotency, frozen: frozen(),
    });
    const committed = await store.commitWorkspaceReadFileResolution({
      ...locator, phase: "execute", idempotency: executeIdempotency,
      expectedRevision: prepared.operation.revision, resolution: completed(),
    });
    const replay = await store.commitWorkspaceReadFileResolution({
      ...locator, phase: "execute", idempotency: executeIdempotency,
      expectedRevision: prepared.operation.revision, resolution: completed(),
    });
    assert.equal(committed.operation.status, "completed");
    assert.equal(replay.disposition, "replayed");
    await assert.rejects(() => store.commitWorkspaceReadFileResolution({
      ...locator, phase: "execute", idempotency: executeIdempotency,
      expectedRevision: prepared.operation.revision,
      resolution: { ...completed(), receiptId: "receipt-drift" },
    }));
  });
}

conformance("in-memory workspace read authority", () => new InMemoryWorkspaceReadFileStore());
conformance("SQLite workspace read authority", () => new SqliteWorkspaceReadFileStore(new DatabaseSync(":memory:")));

function frozen(): FrozenWorkspaceReadFileDispatch {
  return {
    command: structuredClone(command),
    routeIntent: { deviceBindingId: "device-binding-1", runtimeBindingId: "runtime-binding-1" },
    reference: {
      deviceId: command.deviceId, executionId: command.executionId,
      workspaceBindingId: command.workspaceBindingId,
      incarnationId: command.arguments.workspaceIncarnationId,
      deviceBindingId: "device-binding-1", runtimeBindingId: "runtime-binding-1",
      actionDigest: command.actionDigest,
      commandDigest: terminal.commandDigest,
      leaseId: command.leaseId, leaseEpoch: command.leaseEpoch, receiptId: null,
    },
  };
}
function completed() {
  return { status: "completed" as const, executionId: command.executionId,
    receiptId: "receipt-read-1", terminal: structuredClone(terminal) as Extract<DeviceFilesystemReadEvent, { type: "workspace_read.completed" }> };
}
function idempotency(key: string): IdempotencyDescriptor {
  return { scope: "workspace-read-file", key, requestFingerprint: `sha256:${"a".repeat(64)}` };
}
