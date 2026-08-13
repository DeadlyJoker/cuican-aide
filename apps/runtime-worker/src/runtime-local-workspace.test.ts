import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type {
  FrozenWorkspaceReadFileDispatch,
  WorkspaceDeliveryLease,
  WorkspaceOperationRecord,
} from "@crewon/application";

import {
  LocalWorkspaceListDispatchClient,
  LocalWorkspaceReadAuthority,
} from "./runtime-local-workspace.ts";

const authority = {
  workspaceBindingId: "workspace-binding-1",
  incarnationId: "incarnation-1",
  runtimeBindingId: "runtime-binding-1",
};

test("local Workspace list is bounded, byte-sorted, and replayable", async (context) => {
  const root = await workspace(context);
  await mkdir(join(root, "alpha"));
  await writeFile(join(root, "README.md"), "hello");
  const client = new LocalWorkspaceListDispatchClient({ root, authority });
  const operation = listOperation();
  const deliveryLease = lease(operation.executionId);

  const first = await client.execute(
    operation,
    deliveryLease,
    new AbortController().signal,
  );
  assert.deepEqual(
    await client.execute(
      operation,
      deliveryLease,
      new AbortController().signal,
    ),
    first,
  );
  assert.deepEqual(first.status === "completed" ? first.entries : null, [
    { name: "README.md", kind: "file" },
    { name: "alpha", kind: "directory" },
  ]);
});

test("local Workspace list rejects symbolic links", async (context) => {
  const root = await workspace(context);
  await writeFile(join(root, "target.txt"), "target");
  symlinkSync(join(root, "target.txt"), join(root, "linked.txt"));
  const client = new LocalWorkspaceListDispatchClient({ root, authority });
  const operation = listOperation();
  await assert.rejects(
    client.execute(
      operation,
      lease(operation.executionId),
      new AbortController().signal,
    ),
    /workspace_list_link_entry_unsupported/u,
  );
});

test("local Workspace read is replayable and rejects symbolic-link escape", async (context) => {
  const root = await workspace(context);
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "README.md"), "local workspace");
  const command = readCommand();
  const workspaceRead = new LocalWorkspaceReadAuthority({ root, authority });
  const first = await workspaceRead.execute(
    command,
    new AbortController().signal,
  );
  assert.deepEqual(
    await workspaceRead.execute(command, new AbortController().signal),
    first,
  );
  assert.equal(
    first.status === "completed" ? first.result.content : null,
    "local workspace",
  );

  await rm(join(root, "docs", "README.md"));
  symlinkSync(tmpdir(), join(root, "docs", "README.md"));
  await assert.rejects(
    workspaceRead.execute(
      { ...command, executionId: "filesystem-read-symlink" },
      new AbortController().signal,
    ),
    /workspace_read_link_unsupported/u,
  );
});

async function workspace(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "crewon-runtime-local-workspace-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function listOperation(): WorkspaceOperationRecord {
  const command = {
    executionId: "workspace-list-1",
    ...authority,
    policySnapshotId: "policy-1",
    actionDigest: `sha256:${"a".repeat(64)}`,
    commandDigest: `sha256:${"b".repeat(64)}`,
    limits: {
      depth: 0 as const,
      maxEntries: 100,
      maxNameBytes: 255,
      maxOutputBytes: 64 * 1024,
      maxScannedEntries: 10_000,
      maxScannedNameBytes: 1024 * 1024,
      timeoutMs: 30_000,
    },
  };
  return {
    schemaVersion: "crewon.workspace-operation.v0",
    tenantId: "tenant-1",
    spaceId: "space-1",
    threadId: "thread-1",
    expectedThreadRevision: 1,
    principalId: "principal-1",
    actorId: "actor-1",
    idempotencyKey: "workspace-list-key",
    executionId: command.executionId,
    revision: 1,
    status: "prepared",
    command,
    resolution: null,
  };
}

function lease(executionId: string): WorkspaceDeliveryLease {
  const now = Date.now();
  return {
    schemaVersion: "crewon.workspace-delivery-lease.v0",
    executionId,
    attemptNumber: 1,
    phase: "execute",
    ownerId: "worker-1",
    leaseId: "lease-1",
    epoch: 1,
    leasedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
}

function readCommand(): FrozenWorkspaceReadFileDispatch {
  return {
    schemaVersion: "crewon.workspace-read-file-command.v0",
    executionId: "filesystem-read-1",
    runId: "run-1",
    stepId: "step-1",
    attemptId: "attempt-1",
    leaseId: "lease-1",
    leaseEpoch: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...authority,
    policySnapshotId: "policy-1",
    actionDigest: `sha256:${"a".repeat(64)}`,
    commandDigest: `sha256:${"b".repeat(64)}`,
    relativePathSegments: ["docs", "README.md"],
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 16 * 1024 * 1024,
    },
    providerReceiptId: null,
  };
}
