import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { RunStoreError } from "@crewon/application";
import { SqliteRunStore } from "./sqlite-run-store.ts";

const scope = { tenantId: "tenant-1", spaceId: "space-1" } as const;
const edge = (
  parentTaskId: string,
  childTaskId: string,
  depth: number,
  childOrdinal: number,
) => ({
  ...scope,
  schemaVersion: "crewon.autonomous-task-edge.v0" as const,
  rootTaskId: "root-task",
  parentTaskId,
  childTaskId,
  depth,
  childOrdinal,
});

test("SQLite autonomous edge storage is explicit, idempotent and bounded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-autonomous-edge-"));
  const path = join(directory, "control.sqlite");
  const store = new SqliteRunStore(path);
  try {
    const edges = await store.experimentalAutonomousTaskEdgeStore();
    await assert.rejects(
      edges.listChildren({ ...scope, parentTaskId: "root-task" }),
      (error) =>
        error instanceof RunStoreError &&
        error.code === "autonomous_task_edge_schema_unavailable",
    );
    await edges.migrate();
    const first = await edges.link(edge("root-task", "child-1", 1, 1));
    assert.equal(first.disposition, "created");
    assert.equal(first.edge.createdAt >= 0, true);
    const replay = await edges.link(edge("root-task", "child-1", 1, 1));
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.edge.createdAt, first.edge.createdAt);
    await edges.link(edge("root-task", "child-2", 1, 2));
    await edges.link(edge("child-1", "grandchild-1", 2, 1));
    assert.deepEqual(
      (await edges.listChildren({ ...scope, parentTaskId: "root-task" })).map(
        (value) => value.childTaskId,
      ),
      ["child-1", "child-2"],
    );
    assert.deepEqual(
      (await edges.listDescendants({ ...scope, rootTaskId: "root-task" })).map(
        (value) => value.childTaskId,
      ),
      ["child-1", "child-2", "grandchild-1"],
    );
    await assert.rejects(
      edges.link(edge("root-task", "different-child", 1, 1)),
      (error) =>
        error instanceof RunStoreError &&
        error.code === "autonomous_task_edge_conflict",
    );
    await assert.rejects(
      edges.listDescendants({ ...scope, rootTaskId: "root-task", limit: 33 }),
      (error) =>
        error instanceof RunStoreError &&
        error.code === "autonomous_task_edge_limit_invalid",
    );
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
