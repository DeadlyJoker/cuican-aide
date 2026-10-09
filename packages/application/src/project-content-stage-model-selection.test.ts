import test from "node:test";
import assert from "node:assert/strict";
import { projectModelSelectionFixture } from "./project-model-selection.test-support.ts";
import { ProjectAssetStageApplicationService } from "./project-asset-stage-application-service.ts";
import { ProjectMediaInputStageApplicationService } from "./project-media-input-stage-application-service.ts";
import { target as originalTarget } from "../../store/src/extension-store.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const)
  for (const kind of ["character", "scene", "prop", "media-input"] as const)
    test(
      `${backend}: ${kind} original application and SQL bind the selected model and cold replay keeps one Run`,
      { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
      async (t) => {
        const f = await projectModelSelectionFixture(t, backend);
        await f.parent.projectAssetStore().migrate();
        await f.parent.projectAssetStore().projectMediaInputStore().migrate();
        const common = {
          conversations: f.store,
          threadStore: f.parent,
          projects: f.metadata,
          texts: f.parent.projectTextStore(),
          authorization: {
            async authorize() {
              return { outcome: "allow" as const };
            },
          },
          digester: f.digester,
        };
        const assetStages = f.parent.projectAssetStageStore(),
          mediaStages = f.parent.projectMediaInputStageStore();
        await assetStages.migrate();
        await mediaStages.migrate();
        const assetAuthority = {
            ...f.authority,
            version: "crewon.project-asset-stage-commit.v1" as const,
          },
          mediaAuthority = {
            ...f.authority,
            version: "crewon.project-media-input-stage-commit.v1" as const,
          };
        const assetRequest = {
            ...f.input,
            stage: {
              kind: "assets" as const,
              assetKind: kind === "media-input" ? ("character" as const) : kind,
              briefRevision: 1,
              script: null,
            },
          },
          mediaRequest = {
            ...f.input,
            stage: {
              kind: "media-input" as const,
              workflowId: "krea2-reference-four-view" as const,
              configurationRevision: 1,
              briefRevision: 1,
              script: null,
            },
          };
        const start = (
          unavailable = false,
          changed = false,
          grants: { copyGrant?: boolean; omitGrant?: boolean } = {},
        ) => {
          const tasks = f.createTasks({ unavailable, ...grants });
          return kind === "media-input"
            ? new ProjectMediaInputStageApplicationService({
                ...common,
                tasks,
                stages: mediaStages,
              }).startStage(
                f.actor,
                {
                  ...mediaRequest,
                  ...(changed ? { modelId: "gpt-5.6-luna" } : {}),
                },
                mediaAuthority,
              )
            : new ProjectAssetStageApplicationService({
                ...common,
                tasks,
                stages: assetStages,
              }).startStage(
                f.actor,
                {
                  ...assetRequest,
                  ...(changed ? { modelId: "gpt-5.6-luna" } : {}),
                },
                assetAuthority,
              );
        };
        for (const grants of [{ copyGrant: true }, { omitGrant: true }]) {
          await assert.rejects(start(false, false, grants));
          assert.equal(
            (await f.parent.loadThreadInSpace({
              ...f.actor,
              threadId: f.input.threadId,
            }))!.revision,
            1,
          );
        }
        f.state.beforeTransaction = () => {
          f.model.live = false;
        };
        await assert.rejects(start());
        assert.equal(
          (await f.parent.loadThreadInSpace({
            ...f.actor,
            threadId: f.input.threadId,
          }))!.revision,
          1,
        );
        f.model.live = true;
        f.state.beforeTransaction = null;
        const before = f.model.preparations;
        const first = await start();
        const locator = { ...f.actor, runId: first.runId };
        const binding = await f.first.store.loadExtensionRunBinding(locator);
        assert.deepEqual(binding!.target, f.modelTarget);
        assert.equal(f.model.preparations, before + 1);
        assert.deepEqual(
          (await f.first.store.loadExtensionActivation(binding!))!.target,
          originalTarget,
        );
        f.model.live = false;
        const second = await start(true);
        assert.equal(second.runId, first.runId);
        assert.equal(second.disposition, "replayed");
        assert.equal(f.model.preparations, before + 1);
        await assert.rejects(start(true, true));
        assert.equal(
          (await f.parent.loadThreadInSpace({
            ...f.actor,
            threadId: f.input.threadId,
          }))!.revision,
          2,
        );
      },
    );
