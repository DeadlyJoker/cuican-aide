import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  ProjectTextApplicationService,
  type ProjectMediaInputStageCommitAuthority,
} from "@crewon/application";
import { conversationFixture } from "./project-conversation-store.test-support.ts";
import {
  assetTestOptions,
  hasAssetCause,
} from "./project-asset.test-support.ts";
import { timestamp } from "./extension-store.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} media-input D18 Turn rejects changed script or outline selection while committed original sources replay unchanged`,
    assetTestOptions(backend),
    async (t) => {
      const f = await conversationFixture(t, backend),
        p = await f.prepare();
      await f.store.commitBinding(p, { authority: f.authority });
      const textStore = f.parent.projectTextStore();
      await textStore.migrate();
      await f.parent.projectAssetStore().migrate();
      await f.parent.projectAssetStore().projectMediaInputStore().migrate();
      const stages = f.parent.projectMediaInputStageStore();
      await stages.migrate();
      const texts = new ProjectTextApplicationService({
        store: textStore,
        projects: f.metadata,
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        clock: { now: () => timestamp },
        ids: { nextId: () => randomUUID() },
        digester: f.digester,
      });
      const projectId = f.reference.projectId,
        outline = await texts.saveOutlineCandidate(f.actor, {
          projectId,
          expectedArtifactRevision: 0,
          briefRevision: 1,
          content: {
            title: "来信",
            logline: "雨夜的信",
            synopsis: "修复师收到来信",
            episodes: [
              { episodeId: "ep-1", title: "来信", summary: "发现旧信" },
            ],
          },
          idempotencyKey: "outline-1",
        });
      assert.ok(outline.contentRevision?.kind === "outline");
      await texts.selectRevision(f.actor, {
        projectId,
        artifactId: outline.artifact.artifactId,
        expectedArtifactRevision: 1,
        contentRevision: 1,
        idempotencyKey: "outline-select-1",
      });
      const scriptInput = {
          projectId,
          episodeId: "ep-1",
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
        },
        script = await texts.saveScriptCandidate(f.actor, {
          ...scriptInput,
          expectedArtifactRevision: 0,
          idempotencyKey: "script-1",
        });
      await texts.selectRevision(f.actor, {
        projectId,
        artifactId: script.artifact.artifactId,
        expectedArtifactRevision: 1,
        contentRevision: 1,
        idempotencyKey: "script-select-1",
      });
      const brief = await f.metadata.loadBrief({
        owner: {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          principalId: f.actor.principalId,
        },
        projectId,
        briefRevision: 1,
      });
      assert.ok(brief);
      const authority: ProjectMediaInputStageCommitAuthority = {
          ...f.authority,
          version: "crewon.project-media-input-stage-commit.v1",
        },
        scriptRef = {
          artifactId: script.artifact.artifactId,
          episodeId: "ep-1",
          contentRevision: 1,
        },
        command = {
          pluginId: f.pin.pluginId,
          threadId: p.binding.threadId,
          expectedThreadRevision: 1,
          idempotencyKey: "media-input-old-sources",
          intent: {
            kind: "generate" as const,
            input: { prompt: "Prepare storyboard reference inputs" },
          },
        };
      const task = {
        binding: p.binding,
        stage: {
          kind: "media-input" as const,
          workflowId: "flux2-three-reference-storyboard" as const,
          configurationRevision: 1,
          briefRevision: 1,
          script: scriptRef,
        },
        sources: {
          brief: { briefRevision: 1, contentDigest: brief.contentDigest },
          script: {
            ...scriptRef,
            contentDigest: script.contentRevision!.contentDigest,
          },
        },
        content: command.intent.input.prompt,
        authority,
        conversations: f.store,
        stages,
      };
      await texts.saveScriptCandidate(f.actor, {
        ...scriptInput,
        expectedArtifactRevision: 2,
        idempotencyKey: "script-2",
      });
      await texts.selectRevision(f.actor, {
        projectId,
        artifactId: script.artifact.artifactId,
        expectedArtifactRevision: 3,
        contentRevision: 2,
        idempotencyKey: "script-select-2",
      });
      await assert.rejects(
        f.tasks.createProjectMediaInputStageTurnFromHost(
          f.actor,
          command,
          task,
        ),
        hasAssetCause("project_media_input_stage_sources_stale"),
      );
      await texts.selectRevision(f.actor, {
        projectId,
        artifactId: script.artifact.artifactId,
        expectedArtifactRevision: 4,
        contentRevision: 1,
        idempotencyKey: "script-select-original",
      });
      const first = await f.tasks.createProjectMediaInputStageTurnFromHost(
        f.actor,
        command,
        task,
      );
      await texts.saveOutlineCandidate(f.actor, {
        projectId,
        expectedArtifactRevision: 2,
        briefRevision: 1,
        content: { ...outline.contentRevision!.content, logline: "新大纲" },
        idempotencyKey: "outline-2",
      });
      await texts.selectRevision(f.actor, {
        projectId,
        artifactId: outline.artifact.artifactId,
        expectedArtifactRevision: 3,
        contentRevision: 2,
        idempotencyKey: "outline-select-2",
      });
      const replay = await f.tasks.createProjectMediaInputStageTurnFromHost(
        f.actor,
        command,
        task,
      );
      assert.equal(replay.result.binding.runId, first.result.binding.runId);
      assert.deepEqual(replay.mediaInputStageAdmission.sources, task.sources);
      await assert.rejects(
        f.tasks.createProjectMediaInputStageTurnFromHost(
          f.actor,
          {
            ...command,
            idempotencyKey: "new-key-old-outline",
            expectedThreadRevision: first.result.turn.threadState.revision,
          },
          task,
        ),
        hasAssetCause("project_media_input_stage_sources_stale"),
      );
      await f.rows(
        `ALTER TABLE ${f.prefix}plugin_task_admissions DROP COLUMN project_media_input_stage_digest`,
      );
      await assert.rejects(
        stages.loadMediaInputStageAdmission({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: first.result.binding.runId,
        }),
        hasAssetCause("project_media_input_stage_marker_invalid"),
      );
    },
  );
}
