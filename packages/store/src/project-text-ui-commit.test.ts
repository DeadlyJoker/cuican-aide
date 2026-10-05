import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProjectTextApplicationService,
  projectTextUiMutationCommand,
} from "@crewon/application";
import { saveProjectOutlineCandidate } from "@crewon/domain";
import { selectionRecipe } from "./plugin-installation-store.test-support.ts";
import { textUiCommitFixture } from "./project-text-ui-commit.test-support.ts";
import { textAt, textDigester } from "./project-text-store.test-support.ts";

const outline = {
  title: "雨夜",
  logline: "未寄出的信",
  synopsis: "修复师发现雨夜谜题。",
  episodes: [
    { episodeId: "episode-1", title: "来信", summary: "发现一封旧信。" },
  ],
};
const script = {
  title: "来信",
  scenes: [
    {
      sceneId: "scene-1",
      location: "工作室",
      timeOfDay: "夜",
      action: "拆开信封。",
      dialogue: [{ speaker: "修复师", text: "这不是我的笔迹。" }],
    },
  ],
};
const denied = (e: unknown): boolean =>
  e instanceof Error &&
  (/project_text_ui_|metadata_|authorization_|plugin_installation_|authority_invalid|unsupported/u.test(
    e.message,
  ) ||
    (e.cause !== undefined && denied(e.cause)));
const original = (f: Awaited<ReturnType<typeof textUiCommitFixture>>) => ({
  projectId: f.project.project.projectId,
  request: { expectedArtifactRevision: 0, briefRevision: 1, content: outline },
  idempotencyKey: "original-outline",
});
function actual(
  g: ReturnType<Awaited<ReturnType<typeof textUiCommitFixture>>["grant"]>,
) {
  const tx = g.authority.textUiTransaction;
  if (tx === undefined) throw new Error("fixture_missing_text_grant");
  return projectTextUiMutationCommand(tx, textDigester).command;
}
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 30000,
  };
  test(
    `${backend} manual text UI saves candidates, exact-key replays, selects and locks without Run or funding`,
    options,
    async (t) => {
      const f = await textUiCommitFixture(t, backend);
      const g = f.grant(
        "crewon.project-texts.v1.saveOutlineCandidate",
        original(f),
      );
      const saved = await f.text.saveOutlineCandidate(
        f.actor,
        actual(g) as never,
        g.options,
      );
      const replay = await f.text.saveOutlineCandidate(
        f.actor,
        actual(g) as never,
        g.options,
      );
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.artifact, saved.artifact);
      assert.deepEqual(replay.contentRevision, saved.contentRevision);
      const selected = f.grant("crewon.project-texts.v1.selectRevision", {
        projectId: saved.artifact.projectId,
        artifactId: saved.artifact.artifactId,
        request: { expectedArtifactRevision: 1, contentRevision: 1 },
        idempotencyKey: "select",
      });
      const chosen = await f.text.selectRevision(
        f.actor,
        actual(selected) as never,
        selected.options,
      );
      assert.equal(chosen.artifact.selectedContentRevision, 1);
      const lock = f.grant("crewon.project-texts.v1.setLocked", {
        projectId: saved.artifact.projectId,
        artifactId: saved.artifact.artifactId,
        request: { expectedArtifactRevision: 2, locked: true },
        idempotencyKey: "lock",
      });
      await f.text.setLocked(f.actor, actual(lock) as never, lock.options);
      const later = f.grant("crewon.project-texts.v1.saveOutlineCandidate", {
        ...original(f),
        request: {
          expectedArtifactRevision: 3,
          briefRevision: 1,
          content: { ...outline, synopsis: "未选用的新候选。" },
        },
        idempotencyKey: "later-candidate",
      });
      const candidate = await f.text.saveOutlineCandidate(
        f.actor,
        actual(later) as never,
        later.options,
      );
      assert.equal(candidate.artifact.locked, true);
      assert.equal(candidate.artifact.selectedContentRevision, 1);
      const badSelect = f.grant("crewon.project-texts.v1.selectRevision", {
        projectId: saved.artifact.projectId,
        artifactId: saved.artifact.artifactId,
        request: { expectedArtifactRevision: 4, contentRevision: 2 },
        idempotencyKey: "locked-select",
      });
      await assert.rejects(
        f.text.selectRevision(
          f.actor,
          actual(badSelect) as never,
          badSelect.options,
        ),
        /locked/,
      );
      const sourced = f.grant("crewon.project-texts.v1.saveScriptCandidate", {
        projectId: saved.artifact.projectId,
        episodeId: "episode-1",
        request: {
          expectedArtifactRevision: 0,
          briefRevision: 1,
          outline: {
            artifactId: saved.artifact.artifactId,
            contentRevision: 1,
          },
          content: script,
        },
        idempotencyKey: "script",
      });
      const scripted = await f.text.saveScriptCandidate(
        f.actor,
        actual(sourced) as never,
        sourced.options,
      );
      assert.equal(scripted.contentRevision?.outline?.contentRevision, 1);
      const manual = f.grant("crewon.project-texts.v1.saveScriptCandidate", {
        projectId: saved.artifact.projectId,
        episodeId: "imported-episode",
        request: {
          expectedArtifactRevision: 0,
          briefRevision: 1,
          outline: null,
          content: script,
        },
        idempotencyKey: "manual-script",
      });
      const imported = await f.text.saveScriptCandidate(
        f.actor,
        actual(manual) as never,
        manual.options,
      );
      assert.equal(imported.contentRevision?.outline, null);
      assert.deepEqual(await f.textCounts(), {
        project_text_artifacts: 3,
        project_text_revisions: 4,
        project_text_mutation_receipts: 6,
      });
      assert.equal(
        (
          await f.projects.getProject(f.actor, {
            projectId: f.project.project.projectId,
          })
        ).revision,
        f.project.project.revision,
      );
      const reloaded = new ProjectTextApplicationService({
        store: f.parent.projectTextStore(),
        projects: f.parent.creativeProjectStore(),
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        clock: { now: () => "2026-10-05T00:00:00.000Z" },
        ids: { nextId: () => "unused-id" },
        digester: textDigester,
      });
      assert.equal(
        (
          await reloaded.getOutline(f.actor, {
            projectId: saved.artifact.projectId,
          })
        )?.selectedRevision?.contentRevision,
        1,
      );
      assert.equal(
        (
          await reloaded.getScript(f.actor, {
            projectId: saved.artifact.projectId,
            episodeId: "imported-episode",
          })
        )?.selectedRevision,
        null,
      );
      assert.equal(
        (await f.tableNames()).some(
          (name) =>
            name.startsWith("plugin_credit") ||
            name.startsWith("plugin_task_admission") ||
            name === "extension_external_operations",
        ),
        false,
      );
    },
  );
  test(
    `${backend} a valid forged recipe cannot borrow an original text UI receipt`,
    options,
    async (t) => {
      const f = await textUiCommitFixture(t, backend);
      const g = f.grant(
        "crewon.project-texts.v1.saveOutlineCandidate",
        original(f),
      );
      const transaction = g.authority.textUiTransaction;
      assert.ok(transaction);
      const expected = projectTextUiMutationCommand(transaction, textDigester);
      const forged = saveProjectOutlineCandidate(
        {
          project: f.project.project,
          actor: f.actor,
          artifact: null,
          artifactId: "forged-outline",
          expectedArtifactRevision: 0,
          brief: f.project.brief,
          content: { ...outline, synopsis: "Different valid candidate." },
          at: textAt,
        },
        textDigester,
      );
      await assert.rejects(
        f.textStore.commitCandidate(
          {
            kind: "save-outline",
            actor: f.actor,
            project: f.project.project,
            receipt: expected.receipt,
            expectedArtifactRevision: 0,
            ...forged,
          },
          g.options,
        ),
        denied,
      );
      assert.deepEqual(await f.textCounts(), {
        project_text_artifacts: 0,
        project_text_revisions: 0,
        project_text_mutation_receipts: 0,
      });
      const originalResult = await f.text.saveOutlineCandidate(
        f.actor,
        actual(g) as never,
        g.options,
      );
      assert.equal(originalResult.disposition, "committed");
    },
  );
  test(
    `${backend} text UI command, actor, original key and four-action boundary fail closed`,
    options,
    async (t) => {
      const f = await textUiCommitFixture(t, backend);
      const g = f.grant(
        "crewon.project-texts.v1.saveOutlineCandidate",
        original(f),
      );
      const command = actual(g);
      const before = await f.textCounts();
      for (const body of [
        { ...command, idempotencyKey: "changed" },
        { ...command, expectedArtifactRevision: 7 },
        { ...command, content: { ...outline, synopsis: "changed" } },
        { ...command, projectId: "foreign-project" },
      ])
        await assert.rejects(
          f.text.saveOutlineCandidate(f.actor, body as never, g.options),
          denied,
        );
      await assert.rejects(
        f.text.saveOutlineCandidate(
          { ...f.actor, principalId: "foreign-principal" },
          command as never,
          g.options,
        ),
        denied,
      );
      await assert.rejects(
        f.text.saveOutlineCandidate(
          { ...f.actor, tenantId: "foreign-tenant" },
          command as never,
          g.options,
        ),
        denied,
      );
      await assert.rejects(
        f.text.setLocked(f.actor, command as never, g.options),
      );
      await assert.rejects(
        f.projects.appendBrief(
          f.actor,
          {
            projectId: f.project.project.projectId,
            expectedProjectRevision: f.project.project.revision,
            text: "new brief",
            idempotencyKey: "invalid-use",
          },
          g.options,
        ),
        denied,
      );
      await assert.rejects(
        f.text.saveOutlineCandidate(
          f.actor,
          command as never,
          { authority: f.legacyGrant().authority } as never,
        ),
      );
      assert.deepEqual(await f.textCounts(), before);
    },
  );
  test(
    `${backend} exact replay requires current policy, live UI owner and actual complete installation`,
    options,
    async (t) => {
      const f = await textUiCommitFixture(t, backend);
      const g = f.grant(
        "crewon.project-texts.v1.saveOutlineCandidate",
        original(f),
      );
      const command = actual(g);
      const saved = await f.text.saveOutlineCandidate(
        f.actor,
        command as never,
        g.options,
      );
      const before = await f.textCounts();
      f.policy.allow = false;
      await assert.rejects(
        f.text.saveOutlineCandidate(f.actor, command as never, g.options),
        denied,
      );
      f.policy.allow = true;
      g.state.active = false;
      await assert.rejects(
        f.text.saveOutlineCandidate(f.actor, command as never, g.options),
        denied,
      );
      g.state.active = true;
      // Same identity and revision, but altered audit facts must not match the captured full selection.
      const altered = {
        ...f.source.selection,
        updatedByActorId: "different-audit-actor",
      };
      await f.query(
        `UPDATE ${f.prefix}plugin_profile_selections SET record_json=${backend === "sqlite" ? "?" : "$1"} WHERE plugin_id=${backend === "sqlite" ? "?" : "$2"}`,
        [JSON.stringify(altered), f.installation.pluginId],
      );
      await assert.rejects(
        f.text.saveOutlineCandidate(f.actor, command as never, g.options),
        denied,
      );
      await f.query(
        `UPDATE ${f.prefix}plugin_profile_selections SET record_json=${backend === "sqlite" ? "?" : "$1"} WHERE plugin_id=${backend === "sqlite" ? "?" : "$2"}`,
        [JSON.stringify(f.source.selection), f.installation.pluginId],
      );
      const replay = await f.text.saveOutlineCandidate(
        f.actor,
        command as never,
        g.options,
      );
      assert.deepEqual(replay.artifact, saved.artifact);
      await f.installations.commitSelection(
        selectionRecipe(f.source.selection, "disable-text-ui", {
          actor: f.actor,
          state: "disabled",
        }),
      );
      await assert.rejects(
        f.text.saveOutlineCandidate(f.actor, command as never, g.options),
        denied,
      );
      assert.deepEqual(await f.textCounts(), before);
    },
  );
  test(
    `${backend} read-like installation views cannot supply manual text commit authority`,
    options,
    async (t) => {
      const f = await textUiCommitFixture(t, backend);
      const g = f.grant(
        "crewon.project-texts.v1.saveOutlineCandidate",
        original(f),
      );
      await f.execute(
        `ALTER TABLE ${f.prefix}plugin_profile_selections RENAME TO plugin_profile_selections_real`,
      );
      await f.execute(
        `CREATE VIEW ${f.prefix}plugin_profile_selections AS SELECT * FROM ${f.prefix}plugin_profile_selections_real`,
      );
      try {
        await assert.rejects(
          f.text.saveOutlineCandidate(f.actor, actual(g) as never, g.options),
          denied,
        );
        assert.equal((await f.textCounts()).project_text_revisions, 0);
      } finally {
        await f.execute(`DROP VIEW ${f.prefix}plugin_profile_selections`);
        await f.execute(
          `ALTER TABLE ${f.prefix}plugin_profile_selections_real RENAME TO plugin_profile_selections`,
        );
      }
    },
  );
  if (backend === "sqlite")
    test(
      "sqlite synchronous final active fence rolls back text rows after receipt INSERT",
      options,
      async (t) => {
        const f = await textUiCommitFixture(t, backend);
        const g = f.grant(
          "crewon.project-texts.v1.saveOutlineCandidate",
          original(f),
        );
        assert.ok(f.database);
        f.database.function("withdraw_text_ui", () => {
          g.state.active = false;
          return 0;
        });
        f.database.exec(
          "CREATE TRIGGER withdraw_text_ui AFTER INSERT ON project_text_mutation_receipts BEGIN SELECT withdraw_text_ui(); END;",
        );
        await assert.rejects(
          f.text.saveOutlineCandidate(f.actor, actual(g) as never, g.options),
          denied,
        );
        assert.deepEqual(await f.textCounts(), {
          project_text_artifacts: 0,
          project_text_revisions: 0,
          project_text_mutation_receipts: 0,
        });
      },
    );
  if (backend === "postgres")
    test(
      "postgres final external PDP is transaction-safe and confirmed COMMIT remains successful",
      options,
      async (t) => {
        const f = await textUiCommitFixture(t, backend);
        const g = f.grant(
          "crewon.project-texts.v1.saveOutlineCandidate",
          original(f),
        );
        let inserted = false;
        f.observeTextSql(async (sql) => {
          if (
            sql.startsWith(
              `INSERT INTO "${f.schema}".project_text_mutation_receipts`,
            )
          ) {
            inserted = true;
            f.policy.allow = false;
          }
        });
        await assert.rejects(
          f.text.saveOutlineCandidate(f.actor, actual(g) as never, g.options),
          denied,
        );
        assert.equal(
          inserted,
          true,
          "withdrawal follows the actual receipt INSERT",
        );
        assert.equal((await f.textCounts()).project_text_mutation_receipts, 0);
        f.policy.allow = true;
        let closing: Promise<void> | null = null;
        // Empty preflight receipt transactions also COMMIT; withdraw only after this INSERT.
        inserted = false;
        f.observeTextSql(async (sql) => {
          if (
            sql.startsWith(
              `INSERT INTO "${f.schema}".project_text_mutation_receipts`,
            )
          )
            inserted = true;
          if (sql.trim() === "COMMIT" && inserted) {
            f.closeTextOwner();
            closing = f.parent.close();
          }
        });
        const result = await f.text.saveOutlineCandidate(
          f.actor,
          actual(g) as never,
          g.options,
        );
        assert.equal(result.disposition, "committed");
        assert.equal(inserted, true);
        assert.equal(f.textBorrowed, 0);
        await closing;
        assert.equal((await f.textCounts()).project_text_mutation_receipts, 1);
      },
    );
}
