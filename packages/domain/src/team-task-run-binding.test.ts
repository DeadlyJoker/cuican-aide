import test from "node:test";
import assert from "node:assert/strict";
import {
  captureTeamTaskRunBinding,
  type TeamTaskRunBinding,
} from "./team-task-run-binding.ts";

const binding: TeamTaskRunBinding = {
  schemaVersion: "crewon.team-task-run-binding.v0",
  tenantId: "tenant-1",
  spaceId: "space-1",
  teamTaskId: "task-1",
  parentTaskId: "task-1",
  admissionEpoch: 2,
  capabilitySnapshotId: "capability-1",
};

test("captures and freezes a Team Run binding", () => {
  const captured = captureTeamTaskRunBinding({ ...binding });
  assert.deepEqual(captured, binding);
  assert.equal(Object.isFrozen(captured), true);
});

test("rejects forged or malformed Team Run binding values", () => {
  assert.throws(
    () =>
      captureTeamTaskRunBinding({
        ...binding,
        admissionEpoch: 0,
      }),
    /team_task_run_binding_invalid/u,
  );
  assert.throws(
    () =>
      captureTeamTaskRunBinding({
        ...binding,
        unexpected: true,
      }),
    /team_task_run_binding_invalid/u,
  );
});
