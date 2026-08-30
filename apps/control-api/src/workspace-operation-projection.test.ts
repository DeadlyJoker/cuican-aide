import assert from "node:assert/strict";
import test from "node:test";

import type {
  WorkspaceListResolution,
  WorkspaceOperationRecord,
} from "@crewon/application";

import {
  projectWorkspaceOperation,
  projectWorkspaceOperationEvent,
  projectWorkspaceOperationList,
  projectWorkspaceOperationMutation,
  projectWorkspaceOperationSnapshot,
} from "./workspace-operation-projection.ts";

test("projects every Workspace status without private authority fields", () => {
  const projections = [
    projectWorkspaceOperation(operation("prepared", null, 1)),
    projectWorkspaceOperation(
      operation("completed", resolution("completed"), 2),
    ),
    projectWorkspaceOperation(operation("failed", resolution("failed"), 2)),
    projectWorkspaceOperation(operation("canceled", resolution("canceled"), 2)),
    projectWorkspaceOperation(
      operation("unknownOutcome", resolution("unknownOutcome"), 2),
    ),
  ];
  assert.deepEqual(
    projections.map(({ status, result }) => ({ status, result })),
    [
      { status: "pending", result: null },
      {
        status: "completed",
        result: {
          status: "completed",
          entries: [{ name: "README.md", kind: "file" }],
          truncated: false,
        },
      },
      {
        status: "failed",
        result: {
          status: "failed",
          code: "device.unavailable",
          retryable: true,
        },
      },
      { status: "canceled", result: null },
      { status: "unknownOutcome", result: null },
    ],
  );
  const publicJson = JSON.stringify(projections);
  for (const field of [
    "tenantId",
    "spaceId",
    "principalId",
    "actorId",
    "actionDigest",
    "commandDigest",
    "providerReceiptId",
    "deviceId",
    "workspaceBindingId",
    "incarnationId",
    "runtimeBindingId",
    "policySnapshotId",
    "lease",
    "path",
  ]) {
    assert.equal(publicJson.includes(field), false, field);
  }
});

test("binds mutation, snapshot, and event cursors to the projected revision", () => {
  const internal = operation("completed", resolution("completed"), 2);
  assert.deepEqual(
    projectWorkspaceOperationMutation({
      disposition: "committed",
      operation: internal,
    }),
    {
      disposition: "committed",
      eventSequence: 2,
      operation: projectWorkspaceOperation(internal),
    },
  );
  assert.deepEqual(
    projectWorkspaceOperationSnapshot({
      operation: internal,
      eventSequence: 2,
    }),
    { operation: projectWorkspaceOperation(internal), eventSequence: 2 },
  );
  assert.deepEqual(
    projectWorkspaceOperationEvent(
      { sequence: 2, operation: internal },
      { threadId: "thread-1", executionId: "exec-1", afterSequence: 1 },
    ),
    {
      schemaVersion: "crewon.workspace-operation-event.v0",
      threadId: "thread-1",
      executionId: "exec-1",
      sequence: 2,
      type: "workspace.operation.replaced",
      data: { operation: projectWorkspaceOperation(internal) },
    },
  );
  assert.throws(() =>
    projectWorkspaceOperationEvent(
      { sequence: 2, operation: internal },
      { threadId: "thread-1", executionId: "exec-1", afterSequence: 0 },
    ),
  );
});

test("preserves a proven 100-item list cursor and rejects a 101-item page", () => {
  const operations = Array.from({ length: 101 }, (_, index) =>
    operation("prepared", null, 1, `exec-${String(index).padStart(3, "0")}`),
  );
  const query = {
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    afterExecutionId: null,
    limit: 100,
  } as const;
  const projected = projectWorkspaceOperationList(
    {
      operations: operations.slice(0, 100),
      nextAfterExecutionId: "exec-099",
    },
    query,
  );
  assert.equal(projected.data.length, 100);
  assert.equal(projected.nextAfterExecutionId, "exec-099");
  assert.throws(() =>
    projectWorkspaceOperationList(
      { operations, nextAfterExecutionId: "exec-100" },
      query,
    ),
  );
});

test("fails closed rather than stripping malformed canonical operation fields", () => {
  assert.throws(
    () =>
      projectWorkspaceOperation({
        ...operation("prepared", null, 1),
        tenantSecret: "forged",
      } as WorkspaceOperationRecord),
    /workspace_operation_projection_invalid/u,
  );
  assert.throws(
    () =>
      projectWorkspaceOperationSnapshot({
        operation: operation("prepared", null, 1),
        eventSequence: 2,
      }),
    /workspace_operation_projection_invalid/u,
  );
});

function operation(
  status: WorkspaceOperationRecord["status"],
  result: WorkspaceListResolution | null,
  revision: number,
  executionId = "exec-1",
): WorkspaceOperationRecord {
  return {
    schemaVersion: "crewon.workspace-operation.v0",
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    principalId: "principal-1",
    actorId: "actor-1",
    idempotencyKey: `key-${executionId}`,
    executionId,
    revision,
    status,
    command: {
      executionId,
      workspaceBindingId: "workspace-1",
      incarnationId: "incarnation-1",
      deviceBindingId: "device-binding-1",
      deviceId: "device-1",
      runtimeBindingId: "runtime-binding-1",
      policySnapshotId: "policy-1",
      actionDigest: `sha256:${"a".repeat(64)}`,
      commandDigest: `sha256:${"b".repeat(64)}`,
      limits: {
        depth: 0,
        maxEntries: 5,
        maxNameBytes: 255,
        maxOutputBytes: 64 * 1024,
        maxScannedEntries: 10_000,
        maxScannedNameBytes: 1024 * 1024,
        timeoutMs: 30_000,
      },
    },
    resolution: result,
  };
}

function resolution(
  status: "completed" | "failed" | "canceled" | "unknownOutcome",
): WorkspaceListResolution {
  const common = {
    executionId: "exec-1",
    actionDigest: `sha256:${"a".repeat(64)}`,
    commandDigest: `sha256:${"b".repeat(64)}`,
  };
  if (status === "completed") {
    return {
      status,
      ...common,
      providerReceiptId: "receipt-secret",
      entries: [{ name: "README.md", kind: "file" }],
      truncated: false,
    };
  }
  if (status === "failed") {
    return {
      status,
      ...common,
      providerReceiptId: "receipt-secret",
      code: "device.unavailable",
      retryable: true,
    };
  }
  return {
    status,
    ...common,
    providerReceiptId: status === "canceled" ? "receipt-secret" : null,
  };
}
