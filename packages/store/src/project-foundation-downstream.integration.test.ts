import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createProjectTextPlanRevision } from "@crewon/domain";
import {
  projectAssetFixture,
  assetContent,
  hasAssetCause,
} from "./project-asset.test-support.ts";
import { seedDownstreamFoundation } from "./project-foundation-downstream-integration.test-support.ts";
import { planFixture } from "./project-text-plan.test-support.ts";
import {
  planRunFixture,
  planOutline,
} from "./project-text-plan-run.test-support.ts";

const outline = {
  title: "雨中的信",
  logline: "修复师找到信",
  synopsis: "三封信揭开往事",
  episodes: [{ episodeId: "episode-1", title: "来信", summary: "画中藏着信" }],
};
const script = {
  title: "第一集",
  scenes: [
    {
      sceneId: "scene-1",
      location: "工作室",
      timeOfDay: "夜",
      action: "拿起信",
      dialogue: [{ speaker: "林予", text: "是母亲的笔迹。" }],
    },
  ],
};
const confirmationRequired = hasAssetCause(
  "project_foundation_proposal_confirmation_required",
);

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 30_000,
  };
  test(
    `${backend}: actual text/asset candidate commits require current novel confirmation; replay and history survive invalidation`,
    options,
    async (t) => {
      const f = await projectAssetFixture(t, backend);
      const projectId = f.project.project.projectId;
      const foundation = await seedDownstreamFoundation({
        parent: f.parent,
        project: f.project.project,
        actor: f.actor,
        prefix: f.prefix,
        execute: f.execute,
      });
      const outlineCommand = {
        projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: outline,
        idempotencyKey: "novel-outline",
      };
      const scriptCommand = {
        projectId,
        episodeId: "episode-1",
        expectedArtifactRevision: 0,
        briefRevision: 1,
        outline: null,
        content: script,
        idempotencyKey: "novel-script",
      };
      const assetCommand = {
        projectId,
        assetId: null,
        kind: "character" as const,
        expectedAssetRevision: 0,
        briefRevision: 1,
        script: null,
        content: assetContent,
        idempotencyKey: "novel-character",
      };
      const before = await f.textCounts();
      await assert.rejects(
        f.text.saveOutlineCandidate(f.actor, outlineCommand),
        confirmationRequired,
      );
      await assert.rejects(
        f.text.saveScriptCandidate(f.actor, scriptCommand),
        confirmationRequired,
      );
      await assert.rejects(
        f.assets.saveCandidate(f.actor, assetCommand),
        confirmationRequired,
      );
      assert.deepEqual(await f.textCounts(), before);
      assert.equal(
        Number(
          (
            await f.query(
              `SELECT COUNT(*) AS n FROM ${f.prefix}project_asset_mutation_receipts`,
            )
          )[0]?.n,
        ),
        0,
      );
      await foundation.confirm();
      const savedOutline = await f.text.saveOutlineCandidate(
        f.actor,
        outlineCommand,
      );
      const savedScript = await f.text.saveScriptCandidate(
        f.actor,
        scriptCommand,
      );
      const savedAsset = await f.assets.saveCandidate(f.actor, assetCommand);
      await foundation.invalidate();
      await assert.rejects(
        f.text.saveOutlineCandidate(f.actor, {
          ...outlineCommand,
          expectedArtifactRevision: savedOutline.artifact.revision,
          idempotencyKey: "novel-outline-new",
        }),
        confirmationRequired,
      );
      await assert.rejects(
        f.text.saveScriptCandidate(f.actor, {
          ...scriptCommand,
          expectedArtifactRevision: savedScript.artifact.revision,
          idempotencyKey: "novel-script-new",
        }),
        confirmationRequired,
      );
      await assert.rejects(
        f.assets.saveCandidate(f.actor, {
          ...assetCommand,
          assetId: savedAsset.asset.assetId,
          expectedAssetRevision: savedAsset.asset.revision,
          idempotencyKey: "novel-character-new",
        }),
        confirmationRequired,
      );
      const replayOutline = await f.text.saveOutlineCandidate(
        f.actor,
        outlineCommand,
      );
      const replayScript = await f.text.saveScriptCandidate(
        f.actor,
        scriptCommand,
      );
      const replayAsset = await f.assets.saveCandidate(f.actor, assetCommand);
      assert.equal(replayOutline.disposition, "replayed");
      assert.equal(replayScript.disposition, "replayed");
      assert.equal(replayAsset.disposition, "replayed");
      assert.deepEqual(replayOutline.artifact, savedOutline.artifact);
      assert.deepEqual(replayAsset.asset, savedAsset.asset);
      const selectedOutline = await f.text.selectRevision(f.actor, {
        projectId,
        artifactId: savedOutline.artifact.artifactId,
        expectedArtifactRevision: savedOutline.artifact.revision,
        contentRevision: 1,
        idempotencyKey: "novel-history-outline",
      });
      const selectedAsset = await f.assets.selectRevision(f.actor, {
        projectId,
        assetId: savedAsset.asset.assetId,
        expectedAssetRevision: savedAsset.asset.revision,
        contentRevision: 1,
        idempotencyKey: "novel-history-character",
      });
      assert.equal(selectedOutline.artifact.selectedContentRevision, 1);
      assert.equal(selectedAsset.asset.selectedContentRevision, 1);
      await f.text.setLocked(f.actor, {
        projectId,
        artifactId: savedOutline.artifact.artifactId,
        expectedArtifactRevision: selectedOutline.artifact.revision,
        locked: true,
        idempotencyKey: "novel-lock-outline",
      });
      await f.assets.setLocked(f.actor, {
        projectId,
        assetId: savedAsset.asset.assetId,
        expectedAssetRevision: selectedAsset.asset.revision,
        locked: true,
        idempotencyKey: "novel-lock-character",
      });
      assert.equal((await f.textCounts()).project_text_revisions, 2);
      assert.equal(
        Number(
          (
            await f.query(
              `SELECT COUNT(*) AS n FROM ${f.prefix}project_asset_revisions`,
            )
          )[0]?.n,
        ),
        1,
      );
    },
  );

  test(
    `${backend}: actual creative candidate commits honor confirm-plan and the explicit direct-script choice`,
    options,
    async (t) => {
      for (const creativeStartMode of [
        "confirm-plan",
        "direct-script",
      ] as const) {
        const f = await projectAssetFixture(t, backend);
        const projectId = f.project.project.projectId;
        const foundation = await seedDownstreamFoundation({
          parent: f.parent,
          project: f.project.project,
          actor: f.actor,
          prefix: f.prefix,
          execute: f.execute,
          origin: "creative",
          creativeStartMode,
        });
        const command = {
          projectId,
          episodeId: "episode-1",
          expectedArtifactRevision: 0,
          briefRevision: 1,
          outline: null,
          content: script,
          idempotencyKey: `creative-${creativeStartMode}`,
        };
        if (creativeStartMode === "confirm-plan") {
          await assert.rejects(
            f.text.saveScriptCandidate(f.actor, command),
            confirmationRequired,
          );
          await foundation.confirm();
        }
        assert.equal(
          (await f.text.saveScriptCandidate(f.actor, command)).disposition,
          "committed",
        );
      }
    },
  );

  test(
    `${backend}: actual plan start/resume/revise require current confirmation; pause and committed receipt replay remain available`,
    options,
    async (t) => {
      const f = await planFixture(t, backend);
      const project = await f.metadata.loadProject({
        owner: {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          principalId: f.actor.principalId,
        },
        projectId: f.binding.projectId,
      });
      assert.ok(project);
      const foundation = await seedDownstreamFoundation({
        parent: f.parent,
        project,
        actor: f.actor,
        prefix: f.prefix,
        execute: (sql) => f.rows(sql),
      });
      const d = f.definition();
      await assert.rejects(f.start(d), confirmationRequired);
      assert.equal(
        Number(
          (
            await f.rows(
              `SELECT COUNT(*) AS n FROM ${f.prefix}project_text_plan_receipts`,
            )
          )[0]?.n,
        ),
        0,
      );
      await foundation.confirm();
      const started = await f.start(d);
      await foundation.invalidate();
      const replay = await f.plans.commitControl(started.input, {
        authority: started.q,
      });
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.plan, started.result.plan);
      const paused = await f.plans.commitControl(
        f.control("pause", d, started.result, randomUUID()),
        { authority: f.planAuthority(null) },
      );
      assert.equal(paused.plan.state, "paused");
      for (const kind of ["resume", "reviseRemaining"] as const) {
        const { schemaVersion: _schema, contentDigest: _digest, ...body } = d;
        const next = createProjectTextPlanRevision(
          {
            ...body,
            planRevision: 2,
            delegation: {
              ...d.delegation,
              actionId: `crewon.project-text-plans.v1.${kind}`,
              idempotencyKey: randomUUID(),
            },
          },
          f.digester,
        );
        const command = f.control(kind, next, paused);
        await assert.rejects(
          f.plans.commitControl(command, {
            authority: f.planAuthority(next.delegation),
          }),
          confirmationRequired,
        );
      }
      assert.equal(
        Number(
          (
            await f.rows(
              `SELECT COUNT(*) AS n FROM ${f.prefix}project_text_plan_revisions`,
            )
          )[0]?.n,
        ),
        1,
      );
      assert.equal(
        Number(
          (
            await f.rows(
              `SELECT COUNT(*) AS n FROM ${f.prefix}project_text_plan_receipts`,
            )
          )[0]?.n,
        ),
        2,
      );
      const revoked = await f.plans.commitControl(
        f.control("revoke", d, paused, randomUUID()),
        { authority: f.planAuthority(null) },
      );
      assert.equal(revoked.plan.state, "revoked");
      assert.equal(
        Number(
          (
            await f.rows(`SELECT COUNT(*) AS n FROM ${f.prefix}run_snapshots`)
          )[0]?.n,
        ),
        0,
      );
    },
  );

  test(
    `${backend}: original terminal Run observation and historical adoption survive invalidation, but explicit plan continue is gated`,
    options,
    async (t) => {
      const { run, f, p, operation, terminal } = await planRunFixture(
        t,
        backend,
      );
      const project = await f.metadata.loadProject({
        owner: {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          principalId: f.actor.principalId,
        },
        projectId: f.binding.projectId,
      });
      assert.ok(project);
      const foundation = await seedDownstreamFoundation({
        parent: f.parent,
        project,
        actor: f.actor,
        prefix: f.prefix,
        execute: (sql) => f.rows(sql),
      });
      await foundation.confirm();
      const op = await operation("outline_save", {
        projectId: f.binding.projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: planOutline,
      });
      const saved = await run.text.saveOutlineCandidate(
        f.actor,
        op.commandBody as never,
        op.options,
      );
      await foundation.invalidate();
      const observed = await terminal(op);
      assert.equal(observed.plan.state, "waitingSelection");
      await run.text.selectRevision(f.actor, {
        projectId: f.binding.projectId,
        artifactId: saved.artifact.artifactId,
        expectedArtifactRevision: saved.artifact.revision,
        contentRevision: 1,
        idempotencyKey: randomUUID(),
      });
      const plan = await f.plans.loadPlan({ ...f.owner, planId: p.d.planId });
      assert.ok(plan);
      const steps = await f.plans.listSteps({
        ...f.owner,
        planId: p.d.planId,
        planRevision: 1,
      });
      const before = Number(
        (
          await f.rows(
            `SELECT COUNT(*) AS n FROM ${f.prefix}project_text_plan_receipts`,
          )
        )[0]?.n,
      );
      await assert.rejects(
        f.plans.commitControl(
          f.control(
            "continue",
            p.d,
            { ...p.result, plan, steps },
            randomUUID(),
          ),
          { authority: f.planAuthority(null) },
        ),
        confirmationRequired,
      );
      assert.equal(
        Number(
          (
            await f.rows(
              `SELECT COUNT(*) AS n FROM ${f.prefix}project_text_plan_receipts`,
            )
          )[0]?.n,
        ),
        before,
      );
      assert.equal(
        Number(
          (
            await f.rows(`SELECT COUNT(*) AS n FROM ${f.prefix}run_snapshots`)
          )[0]?.n,
        ),
        1,
      );
    },
  );
}
