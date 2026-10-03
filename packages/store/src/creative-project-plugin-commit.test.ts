import assert from "node:assert/strict";
import test from "node:test";
import {
  application,
  creationRecipe,
  projectTables,
  receipt,
} from "./creative-project-store.test-support.ts";
import { installationRecipe } from "./plugin-installation-store.test-support.ts";
import {
  actor,
  optionsFor,
  pluginCommitFixture,
  selectionRecipe,
} from "./creative-project-plugin-commit.test-support.ts";
import {
  admitSqlitePluginTaskPin,
  admitPostgresPluginTaskPin,
} from "./plugin-task-admission-store-support.ts";
import { SqliteCreativeProjectStore } from "./sqlite-creative-project-store.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} qualified metadata uses the actual installation and all six writes without any paid/task migration`,
    optionsFor(backend),
    async (t) => {
      const f = await pluginCommitFixture(t, backend);
      const service = application(f.projects).service;
      const create = f.grant();
      const first = await service.createProject(
        actor,
        { title: "原项目", briefText: "首版需求", idempotencyKey: "create" },
        { authority: create.authority },
      );
      assert.ok(create.state.fullCalls >= 1);
      assert.ok(create.state.transactionCalls >= 1);
      const renamed = await service.renameProject(
        actor,
        {
          projectId: first.project.projectId,
          title: "新标题",
          expectedProjectRevision: first.project.revision,
          idempotencyKey: "rename",
        },
        {
          authority: f.grant("crewon.creative-projects.v1.renameProject")
            .authority,
        },
      );
      const brief = await service.appendBrief(
        actor,
        {
          projectId: first.project.projectId,
          text: "新版需求",
          expectedProjectRevision: renamed.project.revision,
          idempotencyKey: "brief",
        },
        {
          authority: f.grant("crewon.creative-projects.v1.appendBrief")
            .authority,
        },
      );
      const concept = await service.createConcept(
        actor,
        {
          projectId: first.project.projectId,
          briefRevision: brief.brief.briefRevision,
          name: "首张画面",
          prompt: "雨夜画面",
          expectedProjectRevision: brief.project.revision,
          idempotencyKey: "concept",
        },
        {
          authority: f.grant("crewon.creative-projects.v1.createConcept")
            .authority,
        },
      );
      const next = await service.appendConceptRevision(
        actor,
        {
          projectId: first.project.projectId,
          assetId: concept.asset.assetId,
          briefRevision: brief.brief.briefRevision,
          prompt: "修改画面",
          expectedProjectRevision: concept.project.revision,
          expectedAssetMetadataRevision: concept.asset.revision,
          idempotencyKey: "concept-next",
        },
        {
          authority: f.grant(
            "crewon.creative-projects.v1.appendConceptRevision",
          ).authority,
        },
      );
      const archived = await service.setProjectState(
        actor,
        {
          projectId: first.project.projectId,
          state: "archived",
          expectedProjectRevision: next.project.revision,
          idempotencyKey: "archive",
        },
        {
          authority: f.grant("crewon.creative-projects.v1.setProjectState")
            .authority,
        },
      );
      assert.equal(archived.project.state, "archived");
      assert.deepEqual(await f.counts(), {
        creative_projects: 1,
        creative_project_briefs: 2,
        creative_concept_assets: 1,
        creative_concept_revisions: 2,
        creative_project_mutation_receipts: 6,
      });
      for (const name of [
        "plugin_task_admission_schema_version",
        "plugin_credit_schema_version",
        "extension_credit_schema_version",
        "plugin_query_task_admission_schema_version",
        "project_generation_schema_version",
      ])
        assert.equal((await f.tableNames()).includes(name), false, name);
    },
  );

  test(
    `${backend} qualified metadata binds the actual mutation actor and action before preflight or writes`,
    optionsFor(backend),
    async (t) => {
      const f = await pluginCommitFixture(t, backend);
      for (const change of [
        { principalId: "other-principal" },
        { actorId: "other-actor" },
        { action: "crewon.creative-projects.v1.getProject" },
      ]) {
        const g = f.grant(),
          transaction = g.authority.transaction!;
        const authority = {
          ...g.authority,
          transaction: {
            ...transaction,
            pin: { ...transaction.pin, ...change },
          },
        };
        await assert.rejects(
          f.projects.commitProjectCreation(
            creationRecipe("bad-owner", JSON.stringify(change)),
            { authority },
          ),
          /creative_project_plugin_commit_pin_mismatch/u,
        );
        assert.equal(g.state.fullCalls, 0);
      }
      assert.deepEqual(
        await f.counts(),
        Object.fromEntries(projectTables.map((table) => [table, 0])),
      );
    },
  );

  for (const state of ["disabled", "uninstalled", "changed-package"] as const) {
    test(
      `${backend} actual source ${state} after full preflight is refused on the transaction connection without writes`,
      optionsFor(backend),
      async (t) => {
        const f = await pluginCommitFixture(t, backend),
          g = f.grant();
        g.state.preflightHook = async () => {
          let selection = f.source.selection;
          let packageDigest = f.source.package.packageDigest;
          if (state === "changed-package") {
            const next = await f.otherInstallations.recordInstalledPackage(
              installationRecipe("source-next-install", {
                scope: f.scope,
                actor,
                pluginId: f.source.package.pluginId,
                version: "6.0.0",
                expectedSelectionRevision: f.source.selection.revision,
              }),
            );
            selection = next.selection;
            packageDigest = next.package.packageDigest;
          }
          await f.otherInstallations.commitSelection(
            selectionRecipe(selection, "withdraw-source", {
              actor,
              state: state === "changed-package" ? "enabled" : state,
              packageDigest,
            }),
          );
        };
        await assert.rejects(
          f.projects.commitProjectCreation(
            creationRecipe("withdrawn", "create-withdrawn"),
            { authority: g.authority },
          ),
          /plugin_installation_pin_conflict/u,
        );
        assert.deepEqual(
          await f.counts(),
          Object.fromEntries(projectTables.map((table) => [table, 0])),
        );
      },
    );
  }

  test(
    `${backend} same-revision source audit changes are refused by complete captured selection equality`,
    optionsFor(backend),
    async (t) => {
      const f = await pluginCommitFixture(t, backend),
        g = f.grant();
      g.state.preflightHook = async () =>
        f.execute(
          backend === "sqlite"
            ? "UPDATE plugin_profile_selections SET record_json=json_set(record_json,'$.updatedByActorId','actor-audit-replaced')"
            : `UPDATE ${f.prefix}plugin_profile_selections SET record_json=jsonb_set(record_json,'{updatedByActorId}','"actor-audit-replaced"'::jsonb)`,
        );
      await assert.rejects(
        f.projects.commitProjectCreation(
          creationRecipe("audit-tamper", "create-audit-tamper"),
          { authority: g.authority },
        ),
        /creative_project_plugin_commit_selection_mismatch/u,
      );
      assert.deepEqual(
        await f.counts(),
        Object.fromEntries(projectTables.map((table) => [table, 0])),
      );
    },
  );

  test(
    `${backend} qualified receipt replay still proves current source while ordinary metadata ignores installation schema`,
    optionsFor(backend),
    async (t) => {
      const f = await pluginCommitFixture(t, backend),
        g = f.grant(),
        input = creationRecipe("original", "original-create");
      const committed = await f.projects.commitProjectCreation(input, {
        authority: g.authority,
      });
      assert.deepEqual(
        await f.projects.commitProjectCreation(input, {
          authority: g.authority,
        }),
        { ...committed, disposition: "replayed" },
      );
      await f.otherInstallations.commitSelection(
        selectionRecipe(f.source.selection, "disable-replay", {
          actor,
          state: "disabled",
        }),
      );
      await assert.rejects(
        f.projects.commitProjectCreation(input, { authority: g.authority }),
        /metadata_source_changed/u,
      );
      const before = await f.counts();
      await f.execute(
        `UPDATE ${f.prefix}plugin_installation_schema_version SET version=99 WHERE id=1`,
      );
      const ordinary = creationRecipe(
        "ordinary-without-source",
        "ordinary-key",
      );
      const legacy = await f.projects.commitProjectCreation(ordinary);
      assert.equal(legacy.disposition, "committed");
      assert.equal(
        (await f.projects.commitProjectCreation(ordinary)).disposition,
        "replayed",
      );
      assert.equal(
        (await f.counts()).creative_projects,
        before.creative_projects! + 1,
      );
      assert.equal(
        (await f.projects.loadMutationReceipt({
          actor,
          receipt: receipt("ordinary-key"),
          kind: "create-project",
        })) !== null,
        true,
      );
    },
  );

  test(
    `${backend} a future installation version introduced after full preflight rejects qualified metadata without repair`,
    optionsFor(backend),
    async (t) => {
      const f = await pluginCommitFixture(t, backend),
        g = f.grant();
      g.state.preflightHook = async () =>
        f.execute(
          `UPDATE ${f.prefix}plugin_installation_schema_version SET version=99 WHERE id=1`,
        );
      await assert.rejects(
        f.projects.commitProjectCreation(
          creationRecipe("future", "future-create"),
          { authority: g.authority },
        ),
        /plugin_installation_schema_version_unsupported/u,
      );
      assert.deepEqual(
        await f.counts(),
        Object.fromEntries(projectTables.map((table) => [table, 0])),
      );
      assert.equal(
        Number(
          (
            await f.query(
              `SELECT version FROM ${f.prefix}plugin_installation_schema_version`,
            )
          )[0]!.version,
        ),
        99,
      );
    },
  );

  test(
    `${backend} extracted installation reader does not bypass the original task schema gate`,
    optionsFor(backend),
    async (t) => {
      const f = await pluginCommitFixture(t, backend),
        pin = f.grant().authority.transaction!.pin;
      const admit = async () => {
        if (f.database) {
          admitSqlitePluginTaskPin(f.database, pin);
          return;
        }
        const client = await f.pool!.connect();
        try {
          await admitPostgresPluginTaskPin(client, f.schema, pin);
        } finally {
          client.release();
        }
      };
      await assert.rejects(admit(), /plugin_task_admission_schema_version/u);
      assert.equal(
        (await f.tableNames()).includes("plugin_task_admission_schema_version"),
        false,
      );
      await f.execute(
        `CREATE TABLE ${f.prefix}plugin_task_admission_schema_version (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);INSERT INTO ${f.prefix}plugin_task_admission_schema_version VALUES(1,99)`,
      );
      await assert.rejects(
        admit(),
        /plugin_task_admission_schema_version_unsupported/u,
      );
      assert.equal(
        Number(
          (
            await f.query(
              `SELECT version FROM ${f.prefix}plugin_task_admission_schema_version`,
            )
          )[0]!.version,
        ),
        99,
      );
      assert.deepEqual(
        await f.counts(),
        Object.fromEntries(projectTables.map((table) => [table, 0])),
      );
    },
  );
}

test("SQLite qualified metadata withdrawal inside the synchronous receipt write rolls back every row", async (t) => {
  const f = await pluginCommitFixture(t, "sqlite"),
    g = f.grant();
  // Native SQLite functions belong to their real connection; the trigger must run on that connection.
  const projects = new SqliteCreativeProjectStore({
    database: f.database!,
    assertOpen() {},
  });
  f.afterReceipt(() => {
    g.state.active = false;
  });
  await assert.rejects(
    projects.commitProjectCreation(creationRecipe("late", "late-sqlite"), {
      authority: g.authority,
    }),
    /metadata_invocation_withdrawn/u,
  );
  assert.equal(g.state.transactionCalls, 1);
  assert.deepEqual(
    await f.counts(),
    Object.fromEntries(projectTables.map((table) => [table, 0])),
  );
});
