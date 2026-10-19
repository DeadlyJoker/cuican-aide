import assert from "node:assert/strict";
import test from "node:test";
import {
  captureAutonomousTaskBudget,
  captureAutonomousTaskCapability,
} from "./task-lineage-policy.ts";
import { captureAutonomousTaskChildAdmission } from "./autonomous-task-admission.ts";

const childIntent = {
  schemaVersion: "crewon.team-task.v1" as const,
  tenantId: "tenant-1",
  spaceId: "space-1",
  actorId: "actor-1",
  principalId: "principal-1",
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
    responseMode: "manager" as const,
    managerResponseKind: "office" as const,
  },
};
const budget = {
  schemaVersion: "crewon.autonomous-task-budget.v0" as const,
  maxDepth: 3,
  maxChildren: 4,
  deadlineAt: "2030-01-02T03:04:05Z",
  tokenBudget: 1000,
  outputBytesBudget: 4096,
};
const capability = {
  schemaVersion: "crewon.autonomous-task-capability.v0" as const,
  tenantId: "tenant-1",
  spaceId: "space-1",
  actorId: "actor-1",
  principalId: "principal-1",
  authorityId: "authority-1",
  runtimeGeneration: "runtime-1",
  policySnapshotId: "policy-1",
  workspaceBindingId: "workspace-1",
  toolPermissionMode: "requestApproval" as const,
};
const admission = {
  schemaVersion: "crewon.autonomous-task-child-admission.v0" as const,
  idempotencyKey: "spawn-1",
  parentTaskId: "parent-task",
  childTaskId: "child-task",
  edge: {
    schemaVersion: "crewon.autonomous-task-edge.v0" as const,
    rootTaskId: "root-task",
    parentTaskId: "parent-task",
    childTaskId: "child-task",
    depth: 1,
    childOrdinal: 1,
  },
  budget,
  parentCapability: capability,
  capability,
  childIntent,
};

test("child admission capture binds edge, intent, capability and budget without writing", () => {
  const captured = captureAutonomousTaskChildAdmission(admission);
  assert.equal(captured.childTaskId, "child-task");
  assert.ok(Object.isFrozen(captured));
  assert.deepEqual(captured.budget, captureAutonomousTaskBudget(budget));
  assert.deepEqual(
    captured.capability,
    captureAutonomousTaskCapability(capability),
  );
  assert.deepEqual(captured.parentCapability, captured.capability);
});

test("child admission capture rejects mismatched identity, depth and accessors", () => {
  for (const input of [
    { ...admission, childTaskId: "other" },
    { ...admission, edge: { ...admission.edge, childTaskId: "other" } },
    { ...admission, edge: { ...admission.edge, depth: 4 } },
    { ...admission, budget: { ...budget, maxChildren: 0 } },
    {
      ...admission,
      capability: { ...capability, toolPermissionMode: "fullAccess" as const },
    },
    { ...admission, capability: { ...capability, actorId: "other" } },
    { ...admission, childIntent: { ...childIntent, taskId: "other" } },
  ])
    assert.throws(() => captureAutonomousTaskChildAdmission(input));
  let reads = 0;
  const accessor = Object.defineProperty({ ...admission }, "childTaskId", {
    enumerable: true,
    get() {
      reads++;
      return "child-task";
    },
  });
  assert.throws(() => captureAutonomousTaskChildAdmission(accessor));
  assert.equal(reads, 0);
});
