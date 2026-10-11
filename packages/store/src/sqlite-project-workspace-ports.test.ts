import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteRunStore } from "./sqlite-run-store.ts";

test("original Parent workspace port construction remains read/write separated and does not migrate or authorize a fake observation", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "crewon-workspace-parent-ports-"),
  );
  const path = join(directory, "original.sqlite");
  const parent = new SqliteRunStore(path);
  const observer = new DatabaseSync(path);
  t.after(async () => {
    observer.close();
    await parent.close();
    rmSync(directory, { recursive: true });
  });
  const namespaceObjects = () =>
    observer
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name LIKE 'plugin_project_workspace_%' ORDER BY name",
      )
      .all();
  assert.deepEqual(namespaceObjects(), []);
  const reads = parent.pluginProjectWorkspaceNamespaces();
  const writer = parent.pluginProjectWorkspaceNativeRegistrationStore();
  assert.ok(Object.isFrozen(reads));
  assert.ok(Object.isFrozen(writer));
  assert.deepEqual(Object.keys(reads).sort(), [
    "listNamespaces",
    "loadNamespace",
  ]);
  assert.deepEqual(Object.keys(writer), ["recordFromNativeObservation"]);
  await assert.rejects(
    writer.recordFromNativeObservation(
      { version: "crewon.plugin-project-workspace-native-observation.v1" },
      { createdAt: "2026-10-12T00:00:00.000Z" },
    ),
    /plugin_project_workspace_native_observation_unavailable/,
  );
  assert.deepEqual(namespaceObjects(), []);
  await parent.close();
  assert.throws(
    () => parent.pluginProjectWorkspaceNativeRegistrationStore(),
    /closed/,
  );
  assert.throws(() => parent.pluginProjectWorkspaceNamespaces(), /closed/);
});
