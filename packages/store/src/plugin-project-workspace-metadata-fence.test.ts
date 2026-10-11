import assert from "node:assert/strict";
import test from "node:test";
import { ownedProjectSqliteFixture } from "./plugin-project-owned-sqlite.test-support.ts";
import { configureAndMigrateSqlite } from "./sqlite-schema.ts";
import { SqlitePluginProjectWorkspaceStore } from "./sqlite-plugin-project-workspace-store.ts";
import { creativeCreateInput } from "../../application/src/plugin-creative-project-action.test-support.ts";
import { uiTestAt } from "../../application/src/plugin-ui.test-support.ts";

async function fixture(t: Parameters<typeof ownedProjectSqliteFixture>[0]) {
  const f = await ownedProjectSqliteFixture(t);
  configureAndMigrateSqlite(f.db);
  const namespaces = new SqlitePluginProjectWorkspaceStore({
    database: f.db,
    assertOpen() {},
  });
  await namespaces.migrate();
  const ui = await f.ui();
  const created = (await ui.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string };
  };
  const input = {
    projectId: created.project.projectId,
    workspaceId: "owned-workspace",
    createdAt: uiTestAt,
  };
  const count = () =>
    Number(
      f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM plugin_project_workspace_namespaces",
        )
        .get()!.n,
    );
  return { ...f, mounted: ui, namespaces, input, count };
}

test("original namespace transaction binds and replays an actually created protected project's complete owner", async (t) => {
  const f = await fixture(t);
  const results: string[] = [];
  f.mounted.state.afterAction = async (context) => {
    results.push(
      (await f.namespaces.recordFromPluginUi(context, f.input)).disposition,
    );
  };
  await f.mounted.invoke("getProject", { projectId: f.input.projectId });
  await f.mounted.invoke("getProject", { projectId: f.input.projectId });
  assert.deepEqual(results, ["committed", "replayed"]);
  assert.equal(f.count(), 1);
  assert.equal(
    f.db
      .prepare("SELECT workspace_id FROM plugin_project_workspace_namespaces")
      .get()!.workspace_id,
    f.input.workspaceId,
  );
});

test("another actually installed plugin cannot claim a protected project through the original namespace writer", async (t) => {
  const f = await fixture(t);
  const other = await f.ui("example.other");
  const created = (await other.invoke(
    "createProject",
    creativeCreateInput("other-project"),
  )) as { project: { projectId: string } };
  const before = f.counts();
  other.state.afterAction = async (context) => {
    await f.namespaces.recordFromPluginUi(context, f.input);
  };
  await assert.rejects(
    other.invoke("getProject", { projectId: created.project.projectId }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "plugin_ui_unavailable" &&
      error.cause instanceof Error &&
      error.cause.message ===
        "plugin_project_workspace_metadata_owner_conflict",
  );
  assert.equal(f.count(), 0);
  assert.deepEqual(f.counts(), before);
});

test("partial metadata ownership schema refuses namespace publication without changing either store", async (t) => {
  const f = await fixture(t);
  f.db.exec("DROP TABLE plugin_project_metadata_owner_schema_version");
  const before = f.counts();
  // Bypass the protected reader only in the named fixture so the namespace boundary itself is exercised.
  f.mounted.state.rawOverride = { outcome: "ok" };
  f.mounted.state.afterAction = async (context) => {
    await f.namespaces.recordFromPluginUi(context, f.input);
  };
  await assert.rejects(
    f.mounted.invoke("getProject", { projectId: f.input.projectId }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "plugin_ui_unavailable" &&
      error.cause instanceof Error &&
      error.cause.message === "plugin_project_metadata_owner_schema_invalid",
  );
  assert.equal(f.count(), 0);
  assert.deepEqual(f.counts(), before);
});
