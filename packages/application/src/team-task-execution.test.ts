import assert from "node:assert/strict";
import test from "node:test";
import type { ControlTeamRuntimeClient } from "./team-turn-types.ts";
import {
  createTeamTaskAutonomousChildAdmission,
  createTeamTaskAutonomousChildReader,
  createTeamTaskAutonomousChildWaiter,
  createTeamTaskExecutor,
  type TeamTaskExecutionHost,
} from "./team-task-execution.ts";
import type { AutonomousTaskChildAdmission } from "./autonomous-task-admission.ts";
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

test("host child admission binds parent capability instead of accepting caller authority", async () => {
  const capability = {
    schemaVersion: "crewon.autonomous-task-capability.v0" as const,
    ...actor,
    authorityId: "authority-1",
    runtimeGeneration: "runtime-1",
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
    toolPermissionMode: "requestApproval" as const,
  };
  const received: { value: Record<string, unknown> | null } = { value: null };
  const admission = createTeamTaskAutonomousChildAdmission({
    capability,
    store: {
      admitAutonomousChild: async (
        input: AutonomousTaskChildAdmission & { parentFence: TeamTaskFence },
      ) => {
        received.value = input as unknown as Record<string, unknown>;
        return {} as never;
      },
    } as unknown as TeamTaskJournalStore,
  });
  const parentFence: TeamTaskFence = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    taskId: "parent-task",
    ownerId: "owner-1",
    leaseId: "lease-1",
    epoch: 1,
  };
  await admission({
    parentFence,
    admission: {
      schemaVersion: "crewon.autonomous-task-child-admission.v0",
      idempotencyKey: "spawn-1",
      parentTaskId: "parent-task",
      childTaskId: "child-task",
      edge: {
        schemaVersion: "crewon.autonomous-task-edge.v0",
        rootTaskId: "parent-task",
        parentTaskId: "parent-task",
        childTaskId: "child-task",
        depth: 1,
        childOrdinal: 1,
      },
      budget: {
        schemaVersion: "crewon.autonomous-task-budget.v0",
        maxDepth: 1,
        maxChildren: 1,
        deadlineAt: "2030-01-02T03:04:05Z",
        tokenBudget: 100,
        outputBytesBudget: 1024,
      },
      capability,
      childIntent: {
        schemaVersion: "crewon.team-task.v1",
        ...actor,
        taskId: "child-task",
        turn: {
          threadId: "child-thread",
          expectedRevision: 1,
          content: "child work",
          plan: {
            officeVersionId: "office-1",
            officeTitle: "Child office",
            manager: {
              memberId: "manager",
              displayName: "Manager",
              agentVersionId: "agent-manager",
              targetId: "target-manager",
            },
            workers: [
              {
                memberId: "worker",
                displayName: "Worker",
                agentVersionId: "agent-worker",
                targetId: "target-worker",
              },
            ],
          },
          responseMode: "manager",
          managerResponseKind: "office",
        },
      },
    },
  });
  assert.deepEqual(received.value?.parentCapability, capability);
  assert.deepEqual(received.value?.parentFence, parentFence);
  assert.ok(Object.isFrozen(received.value?.parentCapability));
  const {
    parentCapability: _capturedParentCapability,
    parentFence: _capturedParentFence,
    ...spawnRequest
  } = received.value!;
  assert.throws(
    () =>
      admission({
        parentFence,
        admission: {
          ...spawnRequest,
          parentCapability: capability,
        } as never,
      }),
    /autonomous_task_child_admission_invalid/u,
  );
});

test("host child reader binds the parent fence scope and task identity", async () => {
  let received: Record<string, unknown> | null = null;
  const reader = createTeamTaskAutonomousChildReader({
    store: {
      listAutonomousChildren: async (
        input: Parameters<TeamTaskJournalStore["listAutonomousChildren"]>[0],
      ) => {
        received = input as unknown as Record<string, unknown>;
        return [];
      },
    } as unknown as TeamTaskJournalStore,
  });
  const parentFence: TeamTaskFence = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    taskId: "parent-task",
    ownerId: "owner-1",
    leaseId: "lease-1",
    epoch: 1,
  };
  assert.deepEqual(await reader({ parentFence, limit: 4 }), []);
  assert.deepEqual(received, {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    parentTaskId: parentFence.taskId,
    limit: 4,
  });
});

test("host child waiter preserves the parent fence while waiting for child snapshots", async () => {
  let received: Record<string, unknown> | null = null;
  const waiter = createTeamTaskAutonomousChildWaiter({
    reader: async (input) => {
      received = input as unknown as Record<string, unknown>;
      return [
        {
          edge: { childTaskId: "child-task" },
          task: {
            intent: { taskId: "child-task" },
            status: "finalAccepted",
            cancelRequested: false,
          },
        },
      ] as never;
    },
  });
  const parentFence: TeamTaskFence = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    taskId: "parent-task",
    ownerId: "owner-1",
    leaseId: "lease-1",
    epoch: 1,
  };
  const snapshots = await waiter({
    parentFence,
    childTaskIds: ["child-task"],
    deadlineMs: 100,
  });
  assert.equal(snapshots.length, 1);
  assert.deepEqual(received, {
    parentFence,
    limit: 32,
  });
});
