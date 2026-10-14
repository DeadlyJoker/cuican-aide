import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ProjectAssetStageApplicationService } from "./project-asset-stage-application-service.ts";
import type { ProjectAssetStageCommitAuthority } from "./project-asset-stage-authority.ts";
import { ProjectTextApplicationService } from "./project-text-application-service.ts";
import { issuePluginProjectAssetStageReadScope } from "./host-project-workspaces.ts";
import { scriptContent } from "./project-text.test-support.ts";
import { workspaceNamespaceFixture } from "../../store/src/plugin-project-workspace.test-support.ts";
import { foundationMetadataFixture } from "../../store/src/project-foundation-legacy-access.test-support.ts";

// Original SQLite/PG managers, actual UI namespace issuer and original Turn/Run
// admission writer. Stage authority callbacks are named backend fixtures here;
// independent installed Node/publication/PDP checks have Control integration tests.
for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: bound asset availability and script refs preserve ordinary readers, then admit one protected original Run and cold replay`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await workspaceNamespaceFixture(t, backend),
        texts = f.parent.projectTextStore(),
        stages = f.parent.projectAssetStageStore();
      await texts.migrate();
      await f.parent.projectAssetStore().migrate();
      await stages.migrate();
      const allow = { authorize: async () => ({ outcome: "allow" as const }) };
      const text = new ProjectTextApplicationService({
        store: texts,
        projects: f.metadata,
        authorization: allow,
        clock: f.dependencies.clock,
        ids: { nextId: () => randomUUID() },
        digester: f.digester,
      });
      const saved = await text.saveScriptCandidate(f.actor, {
        projectId: f.reference.projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        episodeId: "ep-1",
        outline: null,
        content: scriptContent,
        idempotencyKey: "asset-script-original",
      });
      await text.selectRevision(f.actor, {
        projectId: f.reference.projectId,
        artifactId: saved.artifact.artifactId,
        expectedArtifactRevision: 1,
        contentRevision: 1,
        idempotencyKey: "asset-script-select",
      });
      await f.parent.migratePluginProjectWorkspaceNamespaces();
      await (await f.mounted()).write();
      const prepared = await f.prepare(randomUUID(), "workspace-isolated");
      await f.store.commitBinding(prepared, { authority: f.authority });
      const q: ProjectAssetStageCommitAuthority = Object.freeze({
        version: "crewon.project-asset-stage-commit.v1",
        actor: f.actor,
        installation: f.installation,
        pin: f.authority.pin,
        selection: f.enabled.selection,
        package: f.installed.package,
        assertActive: f.authority.assertActive,
        assertCurrent: f.authority.assertCurrent,
        assertTransactionCurrent: f.authority.assertTransactionCurrent,
      });
      const dependencies = {
        conversations: f.store,
        stages,
        threadStore: f.parent,
        projects: f.metadata,
        texts,
        tasks: f.tasks,
        authorization: allow,
        digester: f.digester,
      };
      const app = new ProjectAssetStageApplicationService(dependencies);
      const sourceRequest = {
        projectId: f.reference.projectId,
        threadId: prepared.binding.threadId,
        expectedBindingRevision: 1,
        briefRevision: 1,
        episodeId: "ep-1",
      };
      assert.equal(
        await app.isAvailable(f.actor, prepared.binding.threadId, q),
        true,
      );
      const ordinary = await app.getScriptSource(f.actor, sourceRequest, q);
      assert.deepEqual(ordinary.script, {
        artifactId: saved.artifact.artifactId,
        episodeId: "ep-1",
        contentRevision: 1,
      });
      const metadata = await foundationMetadataFixture(t, {
        backend,
        path: f.databasePath,
        schema: backend === "postgres" ? f.prefix.slice(1, -2) : "main",
        prefix: f.prefix,
      });
      await metadata.migrate();
      await metadata.mark(f.reference.projectId, f.namespaceOwner());
      assert.equal(
        await f.metadata.loadProject({
          owner: {
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            principalId: f.actor.principalId,
          },
          projectId: f.reference.projectId,
        }),
        null,
      );
      assert.equal(
        await app.isAvailable(f.actor, prepared.binding.threadId, q),
        true,
      );
      assert.deepEqual(
        await app.getScriptSource(f.actor, sourceRequest, q),
        ordinary,
      );
      assert.equal(
        (await f.rows(`SELECT run_id FROM ${f.prefix}run_snapshots`)).length,
        0,
      );
      const scope = issuePluginProjectAssetStageReadScope({
        authority: q,
        binding: prepared.binding,
        request: {
          action: "crewon.project-asset-stage-read.v1",
          input: { ...sourceRequest, purpose: "script-source" },
        },
        digester: f.digester,
      });
      assert.throws(() => f.metadata.bindProjectReads({ ...scope }));
      await assert.rejects(
        f.metadata.bindProjectReads(scope).loadProject({
          owner: {
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            principalId: f.actor.principalId,
          },
          projectId: "foreign",
        }),
      );
      for (const wrong of [
        { ...sourceRequest, projectId: "foreign" },
        { ...sourceRequest, expectedBindingRevision: 2 },
        { ...sourceRequest, briefRevision: 2 },
      ])
        await assert.rejects(app.getScriptSource(f.actor, wrong, q));
      const request = {
        projectId: sourceRequest.projectId,
        threadId: sourceRequest.threadId,
        expectedThreadRevision: 1,
        expectedBindingRevision: 1,
        stage: {
          kind: "assets" as const,
          assetKind: "character" as const,
          briefRevision: 1,
          script: ordinary.script,
        },
        content: "根据已采用剧本整理角色候选",
        idempotencyKey: "bound-asset-original",
      };
      const first = await app.startStage(f.actor, request, q);
      const replay = await new ProjectAssetStageApplicationService(
        dependencies,
      ).startStage(f.actor, request, q);
      assert.equal(replay.runId, first.runId);
      assert.equal(replay.disposition, "replayed");
      assert.equal(
        (await f.rows(`SELECT run_id FROM ${f.prefix}run_snapshots`)).length,
        1,
      );
      const stored = await stages
        .bindProjectReads(
          issuePluginProjectAssetStageReadScope({
            authority: q,
            binding: prepared.binding,
            request: {
              action: "crewon.project-asset-stage-read.v1",
              input: { ...request, purpose: "start-stage" },
            },
            digester: f.digester,
          }),
        )
        .loadAssetStageAdmission({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: first.runId,
        });
      assert.equal(stored?.workspaceId, "workspace-isolated");
      assert.equal(
        stored?.sources.script?.contentDigest,
        saved.contentRevision?.contentDigest,
      );
      f.state.current = false;
      await assert.rejects(
        app.isAvailable(f.actor, prepared.binding.threadId, q),
      );
      await assert.rejects(app.getScriptSource(f.actor, sourceRequest, q));
      await assert.rejects(app.startStage(f.actor, request, q));
      assert.equal(
        (await f.rows(`SELECT run_id FROM ${f.prefix}run_snapshots`)).length,
        1,
      );
    },
  );

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: protected Stage has no fallback for foreign owner or missing registered workspace`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      for (const mismatch of [
        "actorId",
        "profileId",
        "pluginId",
        "publisherId",
        "namespace",
      ] as const) {
        await t.test(mismatch, async (st) => {
          const f = await workspaceNamespaceFixture(st, backend),
            texts = f.parent.projectTextStore(),
            stages = f.parent.projectAssetStageStore();
          await texts.migrate();
          await f.parent.projectAssetStore().migrate();
          await stages.migrate();
          if (mismatch !== "namespace") {
            await f.parent.migratePluginProjectWorkspaceNamespaces();
            await (await f.mounted()).write();
          }
          const prepared = await f.prepare(randomUUID(), "workspace-isolated");
          await f.store.commitBinding(prepared, { authority: f.authority });
          const metadata = await foundationMetadataFixture(st, {
            backend,
            path: f.databasePath,
            schema: backend === "postgres" ? f.prefix.slice(1, -2) : "main",
            prefix: f.prefix,
          });
          await metadata.migrate();
          const owner = { ...f.namespaceOwner() };
          if (mismatch !== "namespace")
            owner[mismatch] =
              mismatch === "pluginId" || mismatch === "publisherId"
                ? "foreign.owner"
                : `foreign-${mismatch}`;
          await metadata.mark(f.reference.projectId, owner);
          const q: ProjectAssetStageCommitAuthority = {
            version: "crewon.project-asset-stage-commit.v1",
            actor: f.actor,
            installation: f.installation,
            pin: f.authority.pin,
            selection: f.enabled.selection,
            package: f.installed.package,
            assertActive: f.authority.assertActive,
            assertCurrent: f.authority.assertCurrent,
            assertTransactionCurrent: f.authority.assertTransactionCurrent,
          };
          const app = new ProjectAssetStageApplicationService({
            conversations: f.store,
            stages,
            threadStore: f.parent,
            projects: f.metadata,
            texts,
            tasks: f.tasks,
            authorization: {
              authorize: async () => ({ outcome: "allow" as const }),
            },
            digester: f.digester,
          });
          const request = {
            projectId: f.reference.projectId,
            threadId: prepared.binding.threadId,
            expectedThreadRevision: 1,
            expectedBindingRevision: 1,
            stage: {
              kind: "assets" as const,
              assetKind: "character" as const,
              briefRevision: 1,
              script: null,
            },
            content: "仅隔离项目",
            idempotencyKey: "must-not-admit",
          };
          await assert.rejects(
            app.isAvailable(f.actor, prepared.binding.threadId, q),
          );
          await assert.rejects(
            app.getScriptSource(
              f.actor,
              {
                projectId: request.projectId,
                threadId: request.threadId,
                expectedBindingRevision: 1,
                briefRevision: 1,
                episodeId: "ep1",
              },
              q,
            ),
          );
          await assert.rejects(app.startStage(f.actor, request, q));
          assert.equal(
            (await f.rows(`SELECT run_id FROM ${f.prefix}run_snapshots`))
              .length,
            0,
          );
          assert.equal(
            (
              await f.rows(
                `SELECT run_id FROM ${f.prefix}project_asset_stage_run_admissions`,
              )
            ).length,
            0,
          );
        });
      }
    },
  );
