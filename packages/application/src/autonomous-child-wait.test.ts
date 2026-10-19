import assert from "node:assert/strict";
import test from "node:test";
import {
  waitForAutonomousChildren,
  type AutonomousChildSnapshotReader,
} from "./autonomous-child-wait.ts";
import type { AutonomousTaskChildRecord } from "./team-task-journal.ts";

function child(
  taskId: string,
  status: "coordinating" | "finalAccepted",
  cancelRequested = false,
) {
  return {
    edge: {
      schemaVersion: "crewon.autonomous-task-edge.v0",
      rootTaskId: "root",
      parentTaskId: "parent",
      childTaskId: taskId,
      depth: 1,
      childOrdinal: taskId === "child-a" ? 1 : 2,
      createdAt: 1,
    },
    task: {
      intent: { taskId },
      status,
      cancelRequested,
    },
  } as unknown as AutonomousTaskChildRecord;
}

test("waitForAutonomousChildren returns requested children in caller order", async () => {
  let reads = 0;
  const read: AutonomousChildSnapshotReader = async () => {
    reads++;
    return reads === 1
      ? [child("child-a", "finalAccepted"), child("child-b", "coordinating")]
      : [child("child-b", "finalAccepted"), child("child-a", "finalAccepted")];
  };
  const result = await waitForAutonomousChildren({
    read,
    childTaskIds: ["child-b", "child-a"],
    deadlineMs: 500,
    pollIntervalMs: 1,
  });
  assert.deepEqual(
    result.map((snapshot) => snapshot.edge.childTaskId),
    ["child-b", "child-a"],
  );
  assert.equal(reads, 2);
});

test("waitForAutonomousChildren treats durable cancellation as settled", async () => {
  const result = await waitForAutonomousChildren({
    read: async () => [child("child-a", "coordinating", true)],
    childTaskIds: ["child-a"],
    deadlineMs: 100,
  });
  assert.equal(result[0]?.task.cancelRequested, true);
});

test("waitForAutonomousChildren fails when a child never settles", async () => {
  await assert.rejects(
    waitForAutonomousChildren({
      read: async () => [child("child-a", "coordinating")],
      childTaskIds: ["child-a"],
      deadlineMs: 5,
      pollIntervalMs: 1,
    }),
    /autonomous_child_wait_deadline_exceeded/u,
  );
});

test("waitForAutonomousChildren stops promptly when the parent signal aborts", async () => {
  const controller = new AbortController();
  const pending = waitForAutonomousChildren({
    read: async () => [child("child-a", "coordinating")],
    childTaskIds: ["child-a"],
    deadlineMs: 5_000,
    pollIntervalMs: 5_000,
    signal: controller.signal,
  });
  controller.abort(new Error("parent_cancelled"));
  await assert.rejects(pending, /parent_cancelled/u);
});
