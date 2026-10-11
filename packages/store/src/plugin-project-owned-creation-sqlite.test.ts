import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { CreativeProjectApplicationService } from "@crewon/application";
import { SqliteCreativeProjectStore } from "./sqlite-creative-project-store.ts";
import { SqlitePluginInstallationStore } from "./sqlite-plugin-installation-store.ts";
import { migrateSqlitePluginProjectMetadataOwners } from "./plugin-project-metadata-owner-schema.ts";
import { selectionRecipe } from "./plugin-installation-store.test-support.ts";
import {
  creativeActionFixture,
  creativeActionDescriptor,
  creativeCreateInput,
} from "../../application/src/plugin-creative-project-action.test-support.ts";
import {
  uiTestActor,
  uiTestAt,
} from "../../application/src/plugin-ui.test-support.ts";

/** Real original SQLite transactions; UI package/policy discovery is an explicit memory fixture, not Native/Web proof. */
async function fixture(
  t: TestContext,
  metadataSchema: "complete" | "absent" = "complete",
) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const store = new SqliteCreativeProjectStore({
    database: db,
    assertOpen() {},
  });
  const installations = new SqlitePluginInstallationStore({
    database: db,
    assertOpen() {},
  });
  await store.migrate();
  await installations.migrate();
  if (metadataSchema === "complete") {
    db.exec("BEGIN IMMEDIATE");
    migrateSqlitePluginProjectMetadataOwners(db);
    db.exec("COMMIT");
  }
  let next = 0;
  const ids = { nextId: () => `owned-project-${++next}` };
  const policy = { allowed: true };
  const service = new CreativeProjectApplicationService({
    store,
    ids,
    clock: { now: () => uiTestAt },
    digester: {
      sha256: (value) =>
        `sha256:${createHash("sha256").update(value).digest("hex")}`,
    },
    authorization: {
      authorize: async () =>
        policy.allowed
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "named_project_create_denied" },
    },
  });
  const owners: { close(): Promise<void> }[] = [];
  t.after(async () => {
    for (const owner of owners) await owner.close();
    db.close();
  });
  const ui = async (pluginId = "example.story") => {
    const f = creativeActionFixture({
      projectService: service,
      creationOwnership: "plugin-project-v1",
      descriptor: creativeActionDescriptor({ pluginId }),
      ...(pluginId === "example.story"
        ? {}
        : {
            packageDigest: `sha256:${createHash("sha256").update(pluginId).digest("hex")}`,
          }),
    });
    owners.push(f.owner);
    const receipt = (key: string) => ({
      idempotencyKey: key,
      requestDigest: `sha256:${createHash("sha256").update(key).digest("hex")}`,
    });
    const installed = await installations.recordInstalledPackage({
      actor: uiTestActor,
      scope: f.ui.state.scope,
      package: f.ui.state.package,
      receipt: receipt(`install-${pluginId}`),
      expectedSelectionRevision: null,
    });
    await installations.commitSelection({
      actor: uiTestActor,
      scope: f.ui.state.scope,
      selection: f.ui.state.selection!,
      expectedSelectionRevision: installed.selection.revision,
      receipt: receipt(`enable-${pluginId}`),
    });
    return f;
  };
  const counts = () =>
    Object.fromEntries(
      [
        "creative_projects",
        "creative_project_briefs",
        "plugin_project_metadata_owners",
        "creative_project_mutation_receipts",
      ].map((table) => [
        table,
        db
          .prepare("SELECT 1 FROM sqlite_schema WHERE name=? AND type='table'")
          .get(table)
          ? Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n)
          : 0,
      ]),
    );
  return { db, store, service, ids, ui, counts, policy, installations };
}

test("original UI creation commits project, brief, full owner and scoped receipt together and replays the same ID", async (t) => {
  const f = await fixture(t);
  const ui = await f.ui();
  const first = (await ui.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string };
    disposition: string;
  };
  const replay = (await ui.invoke(
    "createProject",
    creativeCreateInput(),
  )) as typeof first;
  assert.equal(replay.disposition, "replayed");
  assert.equal(replay.project.projectId, first.project.projectId);
  assert.deepEqual(Object.values(f.counts()), [1, 1, 1, 1]);
  const owner = f.db
    .prepare("SELECT * FROM plugin_project_metadata_owners")
    .get()!;
  assert.equal(owner.actor_id, uiTestActor.actorId);
  assert.equal(owner.principal_id, uiTestActor.principalId);
  assert.equal(owner.plugin_id, ui.ui.state.package.pluginId);
  assert.equal(owner.publisher_id, ui.ui.state.package.publisherId);
  assert.equal(owner.profile_id, ui.ui.state.scope.profileId);
  assert.equal(owner.project_id, first.project.projectId);
  assert.equal(
    await f.store.loadProject({
      owner: {
        tenantId: uiTestActor.tenantId,
        spaceId: uiTestActor.spaceId,
        principalId: uiTestActor.principalId,
      },
      projectId: first.project.projectId,
    }),
    null,
  );
  await assert.rejects(
    ui.invoke("createProject", {
      ...creativeCreateInput(),
      request: { title: "changed", briefText: "changed" },
    }),
    /idempotency_conflict/,
  );
  assert.deepEqual(Object.values(f.counts()), [1, 1, 1, 1]);
});

test("two installed plugins with one external creation key keep separate projects and receipts", async (t) => {
  const f = await fixture(t);
  const a = await f.ui(),
    b = await f.ui("example.other");
  const x = (await a.invoke("createProject", creativeCreateInput())) as {
    project: { projectId: string };
  };
  const y = (await b.invoke(
    "createProject",
    creativeCreateInput(),
  )) as typeof x;
  assert.notEqual(x.project.projectId, y.project.projectId);
  assert.deepEqual(Object.values(f.counts()), [2, 2, 2, 2]);
  assert.equal(
    f.db
      .prepare(
        "SELECT COUNT(DISTINCT idempotency_key) AS n FROM creative_project_mutation_receipts",
      )
      .get()!.n,
    2,
  );
});

test("original SQL identity guard rejects changed creation facts and leaves the owned replay intact", async (t) => {
  const f = await fixture(t);
  const ui = await f.ui();
  const original = await ui.invoke("createProject", creativeCreateInput());
  assert.throws(
    () =>
      f.db.exec(
        "UPDATE creative_projects SET record_json=json_set(record_json,'$.createdByActorId','foreign-original-author')",
      ),
    /creative_project_identity_immutable/,
  );
  const replay = (await ui.invoke(
    "createProject",
    creativeCreateInput(),
  )) as Record<string, unknown>;
  assert.deepEqual({ ...replay, disposition: "committed" }, original);
  assert.deepEqual(Object.values(f.counts()), [1, 1, 1, 1]);
});

test("receipt insertion failure rolls back the already written project, brief and sidecar", async (t) => {
  const f = await fixture(t);
  const ui = await f.ui();
  f.db.exec(
    "CREATE TRIGGER fail_owned_receipt BEFORE INSERT ON creative_project_mutation_receipts BEGIN SELECT RAISE(ABORT,'named_owned_receipt_failure'); END",
  );
  await assert.rejects(ui.invoke("createProject", creativeCreateInput()));
  assert.deepEqual(Object.values(f.counts()), [0, 0, 0, 0]);
  f.db.exec("DROP TRIGGER fail_owned_receipt");
  await ui.invoke("createProject", creativeCreateInput());
  assert.deepEqual(Object.values(f.counts()), [1, 1, 1, 1]);
});

test("a confirmed owned SQL commit remains acknowledged when the Host closes before Service return", async (t) => {
  const f = await fixture(t);
  const ui = await f.ui();
  const commit = f.store.commitOwnedProjectCreation.bind(f.store);
  f.store.commitOwnedProjectCreation = async (input, options) => {
    const result = await commit(input, options);
    // close withdraws synchronously and joins this invocation asynchronously.
    void ui.owner.close();
    return result;
  };
  const result = (await ui.invoke("createProject", creativeCreateInput())) as {
    disposition: string;
  };
  assert.equal(result.disposition, "committed");
  assert.deepEqual(Object.values(f.counts()), [1, 1, 1, 1]);
});

test("creation refuses an occupied legacy project ID rather than adopting it", async (t) => {
  const f = await fixture(t);
  f.ids.nextId = () => "occupied-legacy";
  await f.service.createProject(uiTestActor, {
    title: "legacy",
    briefText: "legacy",
    idempotencyKey: "legacy-create",
  });
  const ui = await f.ui();
  await assert.rejects(ui.invoke("createProject", creativeCreateInput()));
  assert.deepEqual(Object.values(f.counts()), [1, 1, 0, 1]);
});

test("an approved UI invocation does not replace independent creativeProject:create policy", async (t) => {
  const f = await fixture(t);
  const ui = await f.ui();
  f.policy.allowed = false;
  await assert.rejects(
    ui.invoke("createProject", creativeCreateInput()),
    /authorization_denied/,
  );
  assert.deepEqual(Object.values(f.counts()), [0, 0, 0, 0]);
});

test("project policy withdrawn during final Host approval prevents all owned creation writes", async (t) => {
  const f = await fixture(t);
  const ui = await f.ui();
  f.ids.nextId = () => {
    ui.state.beforeHost = async () => {
      f.policy.allowed = false;
    };
    return "named-final-host-revocation";
  };
  await assert.rejects(
    ui.invoke("createProject", creativeCreateInput()),
    /authorization_denied/,
  );
  assert.deepEqual(Object.values(f.counts()), [0, 0, 0, 0]);
});

test("actual installation withdrawal rejects creation even while the UI discovery fixture still reports approval", async (t) => {
  const f = await fixture(t);
  const ui = await f.ui();
  await f.installations.commitSelection(
    selectionRecipe(ui.ui.state.selection!, "disable-actual-source", {
      actor: uiTestActor,
      state: "disabled",
      at: uiTestAt,
    }),
  );
  await assert.rejects(ui.invoke("createProject", creativeCreateInput()));
  assert.deepEqual(Object.values(f.counts()), [0, 0, 0, 0]);
});

for (const schema of ["absent", "partial"] as const) {
  test(`qualified creation refuses ${schema} ownership schema instead of creating a legacy project`, async (t) => {
    const f = await fixture(t, schema === "absent" ? "absent" : "complete");
    const ui = await f.ui();
    if (schema === "partial")
      f.db.exec("DROP TABLE plugin_project_metadata_owner_schema_version");
    await assert.rejects(ui.invoke("createProject", creativeCreateInput()));
    assert.deepEqual(Object.values(f.counts()), [0, 0, 0, 0]);
  });
}
