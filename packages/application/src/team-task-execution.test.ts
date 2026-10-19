import assert from "node:assert/strict";
import test from "node:test";
import type { ControlTeamRuntimeClient } from "./team-turn-types.ts";
import {
  createTeamTaskExecutor,
  type TeamTaskExecutionHost,
} from "./team-task-execution.ts";
import type {
  TeamTaskFence,
  TeamTaskJournalStore,
} from "./team-task-journal.ts";
import type { AutonomousTaskCapabilitySnapshot } from "./task-lineage-policy.ts";

const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
} as const;

test("Team execution host rejects a scheduler fence from another scope before Store access", async () => {
  let reads = 0;
  const host: TeamTaskExecutionHost = {
    actor,
    operations: {} as ControlTeamRuntimeClient,
    digester: { sha256: () => "sha256:" + "0".repeat(64) },
  };
  const execute = createTeamTaskExecutor({
    host,
    store: {
      read: async () => {
        reads++;
        return null;
      },
    } as unknown as TeamTaskJournalStore,
  });
  const fence: TeamTaskFence = {
    tenantId: actor.tenantId,
    spaceId: "other-space",
    taskId: "task-1",
    ownerId: "owner-1",
    leaseId: "lease-1",
    epoch: 1,
  };
  await assert.rejects(
    execute(fence, new AbortController().signal),
    /team_task_host_scope_mismatch/u,
  );
  assert.equal(reads, 0);
});

test("Team execution host rejects a capability snapshot from another identity", async () => {
  const host: TeamTaskExecutionHost = {
    actor,
    autonomousCapability: {
      schemaVersion: "crewon.autonomous-task-capability.v0",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      actorId: "other-actor",
      principalId: actor.principalId,
      authorityId: "authority-1",
      runtimeGeneration: "runtime-1",
      policySnapshotId: "policy-1",
      workspaceBindingId: null,
      toolPermissionMode: "requestApproval",
    } satisfies AutonomousTaskCapabilitySnapshot,
    operations: {} as ControlTeamRuntimeClient,
    digester: { sha256: () => "sha256:" + "0".repeat(64) },
  };
  assert.throws(
    () =>
      createTeamTaskExecutor({
        host,
        store: { read: async () => null } as unknown as TeamTaskJournalStore,
      }),
    /team_task_host_capability_scope_mismatch/u,
  );
});
