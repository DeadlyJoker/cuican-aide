import assert from "node:assert/strict";
import test from "node:test";
import { captureTeamTaskRunBinding } from "./team-task-run-binding.ts";

const binding = {
  schemaVersion: "crewon.team-task-run-binding.v0" as const,
  tenantId: "tenant-1",
  spaceId: "space-1",
  teamTaskId: "team-task-1",
  parentTaskId: "parent-task-1",
  admissionEpoch: 1,
  capabilitySnapshotId: "capability-1",
};

test("Run binding capture returns a frozen server snapshot", () => {
  const captured = captureTeamTaskRunBinding(binding);
  assert.deepEqual(captured, binding);
  assert.ok(Object.isFrozen(captured));
});

test("Run binding capture rejects authority injection and accessors", () => {
  assert.throws(
    () =>
      captureTeamTaskRunBinding({
        ...binding,
        actorId: "forged",
      }),
    /team_task_run_binding_invalid/u,
  );
  let reads = 0;
  const accessor = Object.defineProperty({ ...binding }, "teamTaskId", {
    enumerable: true,
    get() {
      reads++;
      return "team-task-1";
    },
  });
  assert.throws(() => captureTeamTaskRunBinding(accessor));
  assert.equal(reads, 0);
});
