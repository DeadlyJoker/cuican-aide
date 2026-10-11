import assert from "node:assert/strict";
import test from "node:test";
import { creationRecipe } from "./creative-project-store.test-support.ts";
import {
  projectTextFixture,
  textActor,
  textOwner,
} from "./project-text-store.test-support.ts";
import {
  legacyOutlineRecipe,
  legacyScriptRecipe,
  legacyTextReceipt,
  legacyTextMetadataRecipes,
  protectTextFixture,
  textLegacySqlSnapshot,
} from "./project-text-legacy-access.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const migration of ["core", "text"] as const) {
    test(
      `${backend}: original ${migration} explicit DDL remains independent of partial owner metadata`,
      { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
      async (t) => {
        const f = await projectTextFixture(t, backend);
        const recipe = legacyOutlineRecipe(f, "pure-ddl-partial-owner");
        await f.first.text.commitCandidate(recipe);
        const marker = `${f.prefix}plugin_project_metadata_owner_schema_version`;
        await f.execute(`CREATE TABLE ${marker}(id INTEGER,x TEXT)`);
        await f.execute(`INSERT INTO ${marker} VALUES(17,'legacy-sentinel')`);
        const namespace = () =>
          backend === "sqlite"
            ? f.sql(
                "SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name LIKE 'plugin_project_metadata_%' ORDER BY name",
              )
            : f.sql(
                "SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name LIKE 'plugin_project_metadata_%' ORDER BY table_name,ordinal_position",
                [f.schema],
              );
        const ownerBefore = await namespace();
        const markerBefore = await f.sql(`SELECT * FROM ${marker}`);
        const textBefore = await textLegacySqlSnapshot(f);
        const projectsBefore = await f.sql(
          `SELECT * FROM ${f.prefix}creative_projects`,
        );
        await (migration === "core"
          ? f.first.projects.migrate()
          : f.first.text.migrate());
        assert.deepEqual(await namespace(), ownerBefore);
        assert.deepEqual(await f.sql(`SELECT * FROM ${marker}`), markerBefore);
        assert.deepEqual(await textLegacySqlSnapshot(f), textBefore);
        assert.deepEqual(
          await f.sql(`SELECT * FROM ${f.prefix}creative_projects`),
          projectsBefore,
        );
        const scope = {
          owner: textOwner(),
          projectId: f.created.project.projectId,
        };
        for (const read of [
          () => f.first.projects.loadProject(scope),
          () => f.first.text.loadOutline(scope),
          () =>
            f.first.text.loadMutationReceipt({
              actor: textActor,
              kind: "save-outline",
              receipt: recipe.receipt,
            }),
        ])
          await assert.rejects(read(), /schema_invalid/u);
        await assert.rejects(
          f.first.text.commitCandidate(recipe),
          /schema_invalid/u,
        );
        await assert.rejects(
          f.first.projects.commitProjectCreation(
            creationRecipe(
              "pure-ddl-new-project",
              "pure-ddl-create",
              textActor,
            ),
          ),
          /schema_invalid/u,
        );
        assert.deepEqual(await namespace(), ownerBefore);
        assert.deepEqual(await f.sql(`SELECT * FROM ${marker}`), markerBefore);
        assert.deepEqual(await textLegacySqlSnapshot(f), textBefore);
        assert.deepEqual(
          await f.sql(`SELECT * FROM ${f.prefix}creative_projects`),
          projectsBefore,
        );
      },
    );
  }
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: text v1 same-principal details, sources and paged history hide protected metadata`,
    options,
    async (t) => {
      const f = await projectTextFixture(t, backend);
      const recipe = legacyOutlineRecipe(f, "legacy-outline-save");
      const saved = await f.first.text.commitCandidate(recipe);
      await f.first.text.commitCandidate(
        legacyOutlineRecipe(f, "legacy-outline-second", saved.artifact),
      );
      const script = await f.first.text.commitCandidate(
        legacyScriptRecipe(f, "legacy-script-save"),
      );
      const scope = {
        owner: textOwner(),
        projectId: f.created.project.projectId,
      };
      await protectTextFixture(t, f);
      for (const run of [
        () => f.first.text.loadOutline(scope),
        () => f.first.text.loadScript({ ...scope, episodeId: "episode-1" }),
        () =>
          f.first.text.loadArtifact({
            ...scope,
            artifactId: script.artifact.artifactId,
          }),
        () =>
          f.first.text.loadRevision({
            ...scope,
            artifactId: saved.artifact.artifactId,
            contentRevision: 1,
          }),
        () =>
          f.first.text.loadOutlineSourceRevision({
            ...scope,
            artifactId: saved.artifact.artifactId,
            contentRevision: 1,
          }),
        () =>
          f.first.text.loadMutationReceipt({
            actor: textActor,
            kind: "save-outline",
            receipt: recipe.receipt,
          }),
        () =>
          f.first.text.loadMutationReceipt({
            actor: textActor,
            kind: "save-outline",
            receipt: {
              ...recipe.receipt,
              requestDigest: legacyTextReceipt("different").requestDigest,
            },
          }),
      ])
        assert.equal(await run(), null);
      for (const afterArtifactId of [null, saved.artifact.artifactId])
        assert.deepEqual(
          await f.first.text.listArtifacts({
            ...scope,
            afterArtifactId,
            limit: 1,
          }),
          { artifacts: [], nextArtifactId: null },
        );
      for (const afterContentRevision of [0, 1])
        assert.deepEqual(
          await f.first.text.listRevisions({
            ...scope,
            artifactId: saved.artifact.artifactId,
            afterContentRevision,
            limit: 1,
          }),
          { revisions: [], nextContentRevision: null },
        );
    },
  );
  test(
    `${backend}: text v1 protected candidate, selection, lock and actual saved receipt replay reject without changing history`,
    options,
    async (t) => {
      const f = await projectTextFixture(t, backend);
      const recipe = legacyOutlineRecipe(f, "legacy-save");
      const saved = await f.first.text.commitCandidate(recipe);
      const commands = legacyTextMetadataRecipes(
        f,
        saved.artifact,
        saved.contentRevision!,
      );
      await protectTextFixture(t, f);
      const before = await textLegacySqlSnapshot(f);
      for (const run of [
        () => f.first.text.commitCandidate(recipe),
        () =>
          f.first.text.commitCandidate(
            legacyOutlineRecipe(f, "fresh-save", saved.artifact),
          ),
        () =>
          f.first.text.commitCandidate(legacyScriptRecipe(f, "fresh-script")),
        () => f.first.text.commitSelection(commands.selection),
        () => f.first.text.commitLock(commands.lock),
      ]) {
        await assert.rejects(run(), /creative_project_not_found/u);
        assert.deepEqual(await textLegacySqlSnapshot(f), before);
      }
      const reopened = await f.open();
      assert.equal(
        await reopened.text.loadMutationReceipt({
          actor: textActor,
          kind: "save-outline",
          receipt: recipe.receipt,
        }),
        null,
      );
      await assert.rejects(
        reopened.text.commitCandidate(recipe),
        /creative_project_not_found/u,
      );
    },
  );
  test(
    `${backend}: text v1 partial optional owner schema refuses instead of legacy fallback or repair`,
    options,
    async (t) => {
      const f = await projectTextFixture(t, backend);
      const recipe = legacyOutlineRecipe(f, "partial-save");
      await f.first.text.commitCandidate(recipe);
      await f.execute(
        `CREATE TABLE ${f.prefix}plugin_project_metadata_owner_schema_version(id INTEGER)`,
      );
      const before = await textLegacySqlSnapshot(f);
      await assert.rejects(
        f.first.text.loadOutline({
          owner: textOwner(),
          projectId: f.created.project.projectId,
        }),
        /schema_invalid/u,
      );
      await assert.rejects(
        f.first.text.loadMutationReceipt({
          actor: textActor,
          kind: "save-outline",
          receipt: recipe.receipt,
        }),
        /schema_invalid/u,
      );
      await assert.rejects(
        f.first.text.commitCandidate(recipe),
        /schema_invalid/u,
      );
      assert.deepEqual(await textLegacySqlSnapshot(f), before);
    },
  );
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: text v1 replay guards the actual saved project before corrupt JSON or an ordinary replacement recipe`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await projectTextFixture(t, backend);
      const original = legacyOutlineRecipe(f, "saved-protected-receipt");
      await f.first.text.commitCandidate(original);
      const other = await f.projects.createProject(textActor, {
        title: "普通项目",
        briefText: "普通项目的需求",
        idempotencyKey: "ordinary-other-project",
      });
      const ordinary = legacyOutlineRecipe(
        { ...f, created: other },
        "saved-protected-receipt",
      );
      await protectTextFixture(t, f);
      // Test-only corruption bypasses the original immutable receipt trigger, not a production writer.
      await f.execute(
        backend === "sqlite"
          ? "DROP TRIGGER project_text_mutation_receipts_no_update"
          : `DROP TRIGGER project_text_mutation_receipts_no_update_or_delete ON ${f.prefix}project_text_mutation_receipts`,
      );
      await f.execute(
        `UPDATE ${f.prefix}project_text_mutation_receipts SET result_json='{}'`,
      );
      const before = await textLegacySqlSnapshot(f);
      assert.equal(
        await f.first.text.loadMutationReceipt({
          actor: textActor,
          kind: "save-outline",
          receipt: original.receipt,
        }),
        null,
      );
      await assert.rejects(
        f.first.text.commitCandidate(ordinary),
        /creative_project_not_found/u,
      );
      assert.deepEqual(await textLegacySqlSnapshot(f), before);
      // A different key on the still ordinary project remains usable under the same schema.
      const saved = await f.first.text.commitCandidate(
        legacyOutlineRecipe({ ...f, created: other }, "ordinary-fresh-key"),
      );
      assert.equal(saved.artifact.projectId, other.project.projectId);
      assert.equal(
        (
          await f.first.text.listArtifacts({
            owner: textOwner(),
            projectId: other.project.projectId,
            afterArtifactId: null,
            limit: 1,
          })
        ).artifacts.length,
        1,
      );
    },
  );
  test(
    `${backend}: text v1 ordinary malformed receipt still fails in the original decoder`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await projectTextFixture(t, backend);
      const recipe = legacyOutlineRecipe(f, "corrupt-ordinary");
      await f.first.text.commitCandidate(recipe);
      await f.execute(
        backend === "sqlite"
          ? "DROP TRIGGER project_text_mutation_receipts_no_update"
          : `DROP TRIGGER project_text_mutation_receipts_no_update_or_delete ON ${f.prefix}project_text_mutation_receipts`,
      );
      await f.execute(
        `UPDATE ${f.prefix}project_text_mutation_receipts SET result_json='{}'`,
      );
      const before = await textLegacySqlSnapshot(f);
      await assert.rejects(
        f.first.text.loadMutationReceipt({
          actor: textActor,
          kind: "save-outline",
          receipt: recipe.receipt,
        }),
        /extension_manifest_fields_invalid/u,
      );
      await assert.rejects(
        f.first.text.commitCandidate(recipe),
        /extension_manifest_fields_invalid/u,
      );
      assert.deepEqual(await textLegacySqlSnapshot(f), before);
    },
  );
}
