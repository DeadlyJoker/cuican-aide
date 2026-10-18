import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_AUTONOMOUS_TASK_CHILDREN,
  MAX_AUTONOMOUS_TASK_DEPTH,
  MAX_AUTONOMOUS_TASK_OUTPUT_BYTES,
  MAX_AUTONOMOUS_TASK_TOKEN_BUDGET,
  assertAutonomousTaskCapabilitySubset,
  assertAutonomousTaskWithinBudget,
  captureAutonomousTaskBudget,
  captureAutonomousTaskCapability,
  captureAutonomousTaskLineage,
  AutonomousTaskPolicyError,
} from "./task-lineage-policy.ts";

const rootLineage = {
  schemaVersion: "crewon.autonomous-task-lineage.v0" as const,
  rootTaskId: "root-task",
  parentTaskId: null,
  depth: 0,
  childOrdinal: null,
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
  toolPermissionMode: "approveForMe" as const,
};

function rejects(action: () => unknown): void {
  assert.throws(action, (error) => error instanceof AutonomousTaskPolicyError);
}

test("lineage capture freezes root and child shapes without changing current task schemas", () => {
  const result = captureAutonomousTaskLineage(rootLineage);
  assert.deepEqual(result, rootLineage);
  assert.ok(Object.isFrozen(result));
  const child = captureAutonomousTaskLineage({
    ...rootLineage,
    parentTaskId: "root-task",
    depth: 1,
    childOrdinal: 2,
  });
  assert.deepEqual(child, {
    ...rootLineage,
    parentTaskId: "root-task",
    depth: 1,
    childOrdinal: 2,
  });
  rejects(() =>
    captureAutonomousTaskLineage({ ...rootLineage, parentTaskId: "root-task" }),
  );
  rejects(() => captureAutonomousTaskLineage({ ...rootLineage, depth: 1 }));
  rejects(() =>
    captureAutonomousTaskLineage({
      ...rootLineage,
      depth: MAX_AUTONOMOUS_TASK_DEPTH + 1,
    }),
  );
});

test("budget capture normalizes timestamps and enforces bounded depth, children, tokens and output", () => {
  const result = captureAutonomousTaskBudget(budget);
  assert.equal(result.deadlineAt, "2030-01-02T03:04:05.000Z");
  assert.ok(Object.isFrozen(result));
  for (const input of [
    { ...budget, maxChildren: MAX_AUTONOMOUS_TASK_CHILDREN + 1 },
    { ...budget, maxDepth: MAX_AUTONOMOUS_TASK_DEPTH + 1 },
    { ...budget, tokenBudget: MAX_AUTONOMOUS_TASK_TOKEN_BUDGET + 1 },
    { ...budget, outputBytesBudget: MAX_AUTONOMOUS_TASK_OUTPUT_BYTES + 1 },
    { ...budget, tokenBudget: 0 },
    { ...budget, outputBytesBudget: 0 },
    { ...budget, deadlineAt: "not-a-date" },
  ])
    rejects(() => captureAutonomousTaskBudget(input));
});

test("capability capture is a copied snapshot and child permission cannot widen", () => {
  const parent = captureAutonomousTaskCapability(capability);
  const child = captureAutonomousTaskCapability({
    ...capability,
    toolPermissionMode: "requestApproval",
  });
  assertAutonomousTaskCapabilitySubset(parent, child);
  rejects(() =>
    assertAutonomousTaskCapabilitySubset(
      parent,
      captureAutonomousTaskCapability({
        ...capability,
        spaceId: "other-space",
      }),
    ),
  );
  rejects(() =>
    assertAutonomousTaskCapabilitySubset(
      parent,
      captureAutonomousTaskCapability({
        ...capability,
        toolPermissionMode: "fullAccess",
      }),
    ),
  );
});

test("budget application rejects depth, child count, deadline, token and output overshoot", () => {
  const lineage = captureAutonomousTaskLineage(rootLineage);
  const capturedBudget = captureAutonomousTaskBudget(budget);
  const base = {
    lineage,
    budget: capturedBudget,
    childCount: 2,
    tokensUsed: 500,
    outputBytesUsed: 1024,
    now: "2029-01-01T00:00:00Z",
  };
  assert.doesNotThrow(() => assertAutonomousTaskWithinBudget(base));
  rejects(() =>
    assertAutonomousTaskWithinBudget({
      ...base,
      lineage: captureAutonomousTaskLineage({
        ...rootLineage,
        depth: capturedBudget.maxDepth + 1,
        parentTaskId: "parent-task",
        childOrdinal: 1,
      }),
    }),
  );
  rejects(() =>
    assertAutonomousTaskWithinBudget({
      ...base,
      childCount: capturedBudget.maxChildren + 1,
    }),
  );
  rejects(() =>
    assertAutonomousTaskWithinBudget({
      ...base,
      now: capturedBudget.deadlineAt,
    }),
  );
  rejects(() =>
    assertAutonomousTaskWithinBudget({
      ...base,
      tokensUsed: capturedBudget.tokenBudget! + 1,
    }),
  );
  rejects(() =>
    assertAutonomousTaskWithinBudget({
      ...base,
      outputBytesUsed: capturedBudget.outputBytesBudget + 1,
    }),
  );
});

test("captures reject accessors, symbols, prototypes and unknown fields without reading them", () => {
  let reads = 0;
  const accessor = Object.defineProperty({ ...rootLineage }, "depth", {
    enumerable: true,
    get() {
      reads++;
      return 0;
    },
  });
  rejects(() => captureAutonomousTaskLineage(accessor));
  rejects(() => captureAutonomousTaskLineage({ ...rootLineage, extra: true }));
  rejects(() => captureAutonomousTaskLineage(Object.create(rootLineage)));
  rejects(() =>
    captureAutonomousTaskCapability({
      ...capability,
      [Symbol("extra")]: true,
    }),
  );
  assert.equal(reads, 0);
});
