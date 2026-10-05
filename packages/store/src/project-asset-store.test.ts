import assert from "node:assert/strict";
import test from "node:test";
import {
  projectAssetFixture,
  assetTestOptions,
  assetContent,
  hasAssetCause,
  assetAt,
} from "./project-asset.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} asset immutable candidates, adoption, lock and delayed candidate preserve the selected pointer`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetFixture(t, backend),
        projectId = f.project.project.projectId;
      const command = {
        projectId,
        assetId: null,
        kind: "character" as const,
        expectedAssetRevision: 0,
        briefRevision: 1,
        script: null,
        content: assetContent,
        idempotencyKey: "manual-create",
      };
      const a = await f.assets.saveCandidate(f.actor, command),
        assetId = a.asset.assetId;
      assert.equal(a.asset.selectedContentRevision, null);
      const selected = await f.assets.selectRevision(f.actor, {
        projectId,
        assetId,
        expectedAssetRevision: 1,
        contentRevision: 1,
        idempotencyKey: "select",
      });
      await f.assets.setLocked(f.actor, {
        projectId,
        assetId,
        expectedAssetRevision: 2,
        locked: true,
        idempotencyKey: "lock",
      });
      const late = await f.assets.saveCandidate(f.actor, {
        ...command,
        assetId,
        expectedAssetRevision: 3,
        content: { ...assetContent, setting: "迟到的新候选" },
        idempotencyKey: "late",
      });
      assert.equal(late.asset.selectedContentRevision, 1);
      assert.equal(late.asset.locked, true);
      await assert.rejects(
        f.assets.selectRevision(f.actor, {
          projectId,
          assetId,
          expectedAssetRevision: 4,
          contentRevision: 2,
          idempotencyKey: "locked-switch",
        }),
        hasAssetCause("project_asset_locked"),
      );
      const replay = await f.assets.saveCandidate(f.actor, command);
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.asset, a.asset);
      assert.equal(
        (await f.assets.getAsset(f.actor, { projectId, assetId }))!.asset
          .revision,
        4,
      );
      assert.equal(
        (
          await f.assets.listRevisions(f.actor, {
            projectId,
            assetId,
            afterContentRevision: 0,
            limit: 1,
          })
        ).nextContentRevision,
        1,
      );
      await f.assets.setLocked(f.actor, {
        projectId,
        assetId,
        expectedAssetRevision: 4,
        locked: false,
        idempotencyKey: "unlock",
      });
      const adopted = await f.assets.selectRevision(f.actor, {
        projectId,
        assetId,
        expectedAssetRevision: 5,
        contentRevision: 2,
        idempotencyKey: "adopt-late",
      });
      assert.equal(adopted.asset.selectedContentRevision, 2);
      assert.equal(
        selected.contentRevision!.contentDigest,
        a.contentRevision!.contentDigest,
      );
    },
  );
  test(
    `${backend} historical brief/script candidates remain historical while formal adoption rechecks real current sources`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetFixture(t, backend),
        projectId = f.project.project.projectId;
      const script = await f.text.saveScriptCandidate(f.actor, {
        projectId,
        episodeId: "ep-1",
        expectedArtifactRevision: 0,
        briefRevision: 1,
        outline: null,
        content: {
          title: "来信",
          scenes: [
            {
              sceneId: "s-1",
              location: "工作室",
              timeOfDay: "夜",
              action: "看信",
              dialogue: [],
            },
          ],
        },
        idempotencyKey: "script",
      });
      await f.text.selectRevision(f.actor, {
        projectId,
        artifactId: script.artifact.artifactId,
        expectedArtifactRevision: 1,
        contentRevision: 1,
        idempotencyKey: "script-select",
      });
      const command = {
        projectId,
        assetId: null,
        kind: "scene" as const,
        expectedAssetRevision: 0,
        briefRevision: 1,
        script: { artifactId: script.artifact.artifactId, contentRevision: 1 },
        content: assetContent,
        idempotencyKey: "historic",
      };
      const saved = await f.assets.saveCandidate(f.actor, command);
      await f.assets.selectRevision(f.actor, {
        projectId,
        assetId: saved.asset.assetId,
        expectedAssetRevision: 1,
        contentRevision: 1,
        idempotencyKey: "historic-select",
      });
      await f.projects.appendBrief(f.actor, {
        projectId,
        text: "新的需求",
        expectedProjectRevision: f.project.project.revision,
        idempotencyKey: "new-brief",
      });
      const late = await f.assets.saveCandidate(f.actor, {
        ...command,
        assetId: saved.asset.assetId,
        expectedAssetRevision: 2,
        idempotencyKey: "old-brief-late",
      });
      assert.equal(late.contentRevision!.brief.briefRevision, 1);
      assert.equal(
        (await f.assets.getAsset(f.actor, {
          projectId,
          assetId: saved.asset.assetId,
        }))!.dependencyState,
        "stale",
      );
      await assert.rejects(
        f.assets.selectRevision(f.actor, {
          projectId,
          assetId: saved.asset.assetId,
          expectedAssetRevision: 3,
          contentRevision: 2,
          idempotencyKey: "stale-select",
        }),
        hasAssetCause("project_asset_source_stale"),
      );
      assert.equal(
        (await f.assets.getAsset(f.actor, {
          projectId,
          assetId: saved.asset.assetId,
        }))!.asset.selectedContentRevision,
        1,
      );
    },
  );
  test(
    `${backend} CAS concurrency, foreign owner, archive and actual installation withdrawal cannot append`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetFixture(t, backend),
        projectId = f.project.project.projectId,
        create = f.creation();
      await f.stage(create);
      const a = await f.write(create);
      await f.ack((await f.pending())!);
      const c = {
        projectId,
        assetId: a.asset.assetId,
        kind: "character" as const,
        expectedAssetRevision: 1,
        briefRevision: 1,
        script: null,
        content: assetContent,
      };
      const both = await Promise.allSettled([
        f.assets.saveCandidate(f.actor, { ...c, idempotencyKey: "race1" }),
        f.assets.saveCandidate(f.actor, { ...c, idempotencyKey: "race2" }),
      ]);
      assert.equal(both.filter((r) => r.status === "fulfilled").length, 1);
      await assert.rejects(
        f.assets.saveCandidate(
          { ...f.actor, principalId: "foreign" },
          { ...c, idempotencyKey: "foreign" },
        ),
        hasAssetCause("creative_project_not_found"),
      );
      await f.projects.setProjectState(f.actor, {
        projectId,
        state: "archived",
        expectedProjectRevision: f.project.project.revision,
        idempotencyKey: "archive",
      });
      await assert.rejects(
        f.assets.saveCandidate(f.actor, {
          ...c,
          expectedAssetRevision: 2,
          idempotencyKey: "archived",
        }),
        hasAssetCause("creative_project_archived"),
      );
      const withdrawn = f.creation("withdrawn");
      withdrawn.state.active = false;
      await assert.rejects(
        f.stage(withdrawn),
        hasAssetCause("metadata_invocation_withdrawn"),
      );
      assert.equal(
        Number(
          (
            await f.query(
              `SELECT COUNT(*) AS n FROM ${f.prefix}project_asset_revisions`,
            )
          )[0]!.n,
        ),
        2,
      );
    },
  );
  test(
    `${backend} independent asset migration is explicit, immutable history and damaged schema fail closed`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetFixture(t, backend),
        g = f.creation();
      await f.stage(g);
      const a = await f.write(g);
      await assert.rejects(
        f.execute(
          `UPDATE ${f.prefix}project_asset_revisions SET content_digest='tampered'`,
        ),
        /project_asset_history_immutable/u,
      );
      if (backend === "sqlite")
        await f.execute("DROP TRIGGER project_assets_identity_immutable");
      else
        await f.execute(
          `ALTER TABLE ${f.prefix}project_assets DISABLE TRIGGER project_assets_identity_immutable`,
        );
      await assert.rejects(
        f.assetStore.loadAsset({
          owner: {
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            principalId: f.actor.principalId,
          },
          projectId: a.asset.projectId,
          assetId: a.asset.assetId,
        }),
        /project_asset_schema_incomplete/u,
      );
      await assert.rejects(
        f.assetStore.migrate(),
        /project_asset_schema_incomplete/u,
      );
    },
  );
  test(
    `${backend} independent journal survives lost ACK, tombstone replay and blocks cross-project unresolved metadata`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetFixture(t, backend),
        g = f.creation();
      const pending = await f.stage(g);
      assert.equal(pending.phase, "pending");
      await assert.rejects(
        f.ack(pending),
        hasAssetCause("project_asset_ui_intent_pending"),
      );
      const a = await f.write(g),
        original = (await f.pending())!;
      assert.equal(original.phase, "accepted");
      assert.equal(original.receipt!.assetId, a.asset.assetId);
      const second = await f.projects.createProject(f.actor, {
        title: "另一个项目",
        briefText: "独立需求",
        idempotencyKey: "second-project",
      });
      await assert.rejects(
        f.stage(f.creation("cross-project", second.project.projectId)),
        hasAssetCause("project_asset_ui_intent_pending"),
      );
      const cold = f.parent.projectAssetUiIntentJournalStore();
      assert.deepEqual(await f.pending(cold), original);
      assert.equal((await f.write(g)).disposition, "replayed");
      assert.equal(
        Number(
          (
            await f.query(
              `SELECT COUNT(*) AS n FROM ${f.prefix}project_asset_revisions`,
            )
          )[0]!.n,
        ),
        1,
      );
      await assert.rejects(
        f.assets.saveCandidate(f.actor, g.actual.command as never),
        hasAssetCause("project_asset_ui_intent_authority_required"),
      );
      const ack = await f.ack(original, cold);
      assert.equal(ack.disposition, "acknowledged");
      assert.equal(await f.pending(), null);
      assert.equal((await f.ack(original)).disposition, "replayed");
      const privateRead = f.recovery("acknowledge", {
        intentId: original.intentId,
        expectedRevision: original.revision,
      });
      assert.equal(
        (await cold.loadIntent(
          { scope: f.scope, intentId: original.intentId },
          privateRead.options,
        ))!.acknowledgedAt,
        assetAt,
      );
      await assert.rejects(
        f.assets.saveCandidate(f.actor, g.actual.command as never),
        hasAssetCause("project_asset_ui_intent_authority_required"),
      );
      await f.stage(f.creation("cross-project", second.project.projectId));
    },
  );
  test(
    `${backend} journal refuses only a serialized real no-COMMIT conflict; foreign ACK and dropped marker cannot authorize replay`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetFixture(t, backend),
        projectId = f.project.project.projectId;
      const a = await f.assets.saveCandidate(f.actor, {
        projectId,
        assetId: null,
        kind: "prop",
        expectedAssetRevision: 0,
        briefRevision: 1,
        script: null,
        content: assetContent,
        idempotencyKey: "plain",
      });
      const g = f.mutation("crewon.project-assets.v1.setLocked", {
        projectId,
        assetId: a.asset.assetId,
        request: { expectedAssetRevision: 1, locked: false },
        idempotencyKey: "planned-lock",
      });
      await f.stage(g);
      // A successfully prepared command cannot become refused merely because a caller claims a known code.
      const still = await f.journal.observeRejected(
        {
          scope: f.scope,
          intentId: g.intentId,
          at: assetAt,
          code: "project_asset_revision_conflict",
        },
        g.options,
      );
      assert.equal(still.phase, "pending");
      await f.assets.saveCandidate(f.actor, {
        projectId,
        assetId: a.asset.assetId,
        kind: "prop",
        expectedAssetRevision: 1,
        briefRevision: 1,
        script: null,
        content: assetContent,
        idempotencyKey: "concurrent-edit",
      });
      await assert.rejects(
        f.write(g),
        hasAssetCause("project_asset_revision_conflict"),
      );
      const refused = await f.journal.observeRejected(
        {
          scope: f.scope,
          intentId: g.intentId,
          at: assetAt,
          code: "project_asset_revision_conflict",
        },
        g.options,
      );
      assert.equal(refused.phase, "refused");
      assert.equal(refused.receipt, null);
      assert.deepEqual(
        await f.journal.observeRejected(
          {
            scope: f.scope,
            intentId: g.intentId,
            at: assetAt,
            code: "project_asset_revision_conflict",
          },
          g.options,
        ),
        refused,
      );
      const wrong = f.recovery("acknowledge", {
        intentId: "missing",
        expectedRevision: 2,
      });
      await assert.rejects(
        f.journal.acknowledge(
          {
            scope: f.scope,
            intentId: "missing",
            expectedRevision: 2,
            at: assetAt,
          },
          wrong.options,
        ),
        hasAssetCause("project_asset_ui_intent_not_found"),
      );
      await f.ack(refused);
      await assert.rejects(
        f.write(g),
        hasAssetCause("project_asset_ui_intent_refused"),
      );
      await f.execute(
        `DROP TABLE ${f.prefix}project_asset_ui_intent_schema_version`,
      );
      await assert.rejects(
        f.pending(),
        hasAssetCause("project_asset_ui_intent_schema_invalid"),
      );
    },
  );
  test(
    `${backend} adopted script becoming stale through outline changes blocks asset adoption and projects real stale state`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetFixture(t, backend),
        projectId = f.project.project.projectId;
      const content = {
        title: "来信",
        logline: "雨夜",
        synopsis: "发现来信",
        episodes: [{ episodeId: "ep-1", title: "来信", summary: "读信" }],
      };
      const outline = await f.text.saveOutlineCandidate(f.actor, {
        projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content,
        idempotencyKey: "outline",
      });
      await f.text.selectRevision(f.actor, {
        projectId,
        artifactId: outline.artifact.artifactId,
        expectedArtifactRevision: 1,
        contentRevision: 1,
        idempotencyKey: "outline-select",
      });
      const script = await f.text.saveScriptCandidate(f.actor, {
        projectId,
        episodeId: "ep-1",
        expectedArtifactRevision: 0,
        briefRevision: 1,
        outline: {
          artifactId: outline.artifact.artifactId,
          contentRevision: 1,
        },
        content: {
          title: "来信",
          scenes: [
            {
              sceneId: "scene-1",
              location: "工作室",
              timeOfDay: "夜",
              action: "读信",
              dialogue: [],
            },
          ],
        },
        idempotencyKey: "script",
      });
      await f.text.selectRevision(f.actor, {
        projectId,
        artifactId: script.artifact.artifactId,
        expectedArtifactRevision: 1,
        contentRevision: 1,
        idempotencyKey: "script-select",
      });
      const command = {
        projectId,
        assetId: null,
        kind: "character" as const,
        expectedAssetRevision: 0,
        briefRevision: 1,
        script: { artifactId: script.artifact.artifactId, contentRevision: 1 },
        content: assetContent,
        idempotencyKey: "character",
      };
      const asset = await f.assets.saveCandidate(f.actor, command);
      await f.assets.selectRevision(f.actor, {
        projectId,
        assetId: asset.asset.assetId,
        expectedAssetRevision: 1,
        contentRevision: 1,
        idempotencyKey: "adopt-character",
      });
      await f.text.saveOutlineCandidate(f.actor, {
        projectId,
        expectedArtifactRevision: 2,
        briefRevision: 1,
        content: { ...content, logline: "新大纲" },
        idempotencyKey: "outline-late",
      });
      await f.text.selectRevision(f.actor, {
        projectId,
        artifactId: outline.artifact.artifactId,
        expectedArtifactRevision: 3,
        contentRevision: 2,
        idempotencyKey: "outline-new-selection",
      });
      const view = await f.assets.getAsset(f.actor, {
        projectId,
        assetId: asset.asset.assetId,
      });
      assert.equal(view!.dependencyState, "stale");
      assert.deepEqual(view!.staleReasons, ["script-source-stale"]);
      const late = await f.assets.saveCandidate(f.actor, {
        ...command,
        assetId: asset.asset.assetId,
        expectedAssetRevision: 2,
        idempotencyKey: "late-old-sources",
      });
      assert.equal(late.asset.selectedContentRevision, 1);
      await assert.rejects(
        f.assets.selectRevision(f.actor, {
          projectId,
          assetId: asset.asset.assetId,
          expectedAssetRevision: 3,
          contentRevision: 2,
          idempotencyKey: "adopt-stale-script",
        }),
        hasAssetCause("project_asset_source_stale"),
      );
    },
  );
  test(
    `${backend} complete journal schema loss cannot turn accepted reserved key into a legacy receipt replay`,
    assetTestOptions(backend),
    async (t) => {
      const f = await projectAssetFixture(t, backend),
        g = f.creation();
      await f.stage(g);
      const result = await f.write(g);
      await f.ack((await f.pending())!);
      await f.execute(`DROP TABLE ${f.prefix}project_asset_ui_intents`);
      await f.execute(
        `DROP TABLE ${f.prefix}project_asset_ui_intent_schema_version`,
      );
      if (backend === "postgres")
        await f.execute(
          `DROP FUNCTION ${f.prefix}project_asset_ui_intent_immutable()`,
        );
      await assert.rejects(
        f.assets.saveCandidate(f.actor, g.actual.command as never),
        hasAssetCause("project_asset_ui_intent_invalid"),
      );
      assert.equal(
        Number(
          (
            await f.query(
              `SELECT COUNT(*) AS n FROM ${f.prefix}project_asset_revisions`,
            )
          )[0]!.n,
        ),
        1,
      );
      assert.equal(
        (await f.assetStore.loadAsset({
          owner: {
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            principalId: f.actor.principalId,
          },
          projectId: result.asset.projectId,
          assetId: result.asset.assetId,
        }))!.revision,
        1,
      );
    },
  );
}
