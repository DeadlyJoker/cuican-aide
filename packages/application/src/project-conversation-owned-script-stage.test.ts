import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PROJECT_CONVERSATIONS_METHOD_ACTIONS as actions } from "@crewon/contracts/project-conversations";
import { ProjectConversationApplicationService } from "./project-conversation-application-service.ts";
import { ProjectTextApplicationService } from "./project-text-application-service.ts";
import { ApplicationError } from "./application-error.ts";
import { issuePluginProjectConversationStageReadScope } from "./host-project-workspaces.ts";
import { conversationFixture } from "../../store/src/project-conversation-store.test-support.ts";
import { foundationMetadataFixture } from "../../store/src/project-foundation-legacy-access.test-support.ts";

// Actual original SQL/Task writers, named installed execution authority. Manual
// artifacts precede the negative ownership constraint; this does not prove owned writes.
for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: protected script preparation pins saved outline and cold replays one original Run`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await conversationFixture(t, backend);
      const texts = f.parent.projectTextStore();
      await texts.migrate();
      const allow = { authorize: async () => ({ outcome: "allow" as const }) };
      const clock = f.dependencies.clock;
      const ids = { nextId: () => randomUUID() };
      const text = new ProjectTextApplicationService({
        store: texts,
        projects: f.metadata,
        authorization: allow,
        clock,
        ids,
        digester: f.digester,
      });
      const saved = await text.saveOutlineCandidate(f.actor, {
        projectId: f.reference.projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: {
          title: "夜航",
          logline: "来信",
          synopsis: "雨夜",
          episodes: [{ episodeId: "ep1", title: "第一集", summary: "暗号" }],
        },
        idempotencyKey: "script-source-outline",
      });
      await text.selectRevision(f.actor, {
        projectId: f.reference.projectId,
        artifactId: saved.artifact.artifactId,
        expectedArtifactRevision: 1,
        contentRevision: 1,
        idempotencyKey: "script-outline-select",
      });
      const prepared = await f.prepare();
      await f.store.commitBinding(prepared, { authority: f.authority });
      const metadata = await foundationMetadataFixture(t, {
        backend,
        schema: backend === "postgres" ? f.prefix.slice(1, -2) : "main",
        prefix: f.prefix,
        path: f.databasePath,
      });
      await metadata.migrate();
      const owner = {
        ...f.actor,
        profileId: f.installation.profileId,
        pluginId: f.installation.pluginId,
        publisherId: f.installation.publisherId,
      };
      await metadata.mark(f.reference.projectId, owner);
      const dependencies = {
        conversations: f.store,
        threads: f.threads,
        threadStore: f.parent,
        projects: f.metadata,
        texts,
        tasks: f.tasks,
        authorization: allow,
        clock,
        ids,
        digester: f.digester,
      };
      const request = {
        projectId: f.reference.projectId,
        threadId: prepared.binding.threadId,
        expectedThreadRevision: 1,
        expectedBindingRevision: 1,
        stage: {
          kind: "script" as const,
          briefRevision: 1,
          episodeId: "ep1",
          outline: {
            artifactId: saved.artifact.artifactId,
            contentRevision: 1,
          },
        },
        content: "根据保存的大纲写第一集",
        idempotencyKey: "owned-script-stage",
      };
      const scope = (input = request) =>
        issuePluginProjectConversationStageReadScope({
          authority: f.authority,
          request: { action: actions.startStage, input },
        });
      const app = new ProjectConversationApplicationService(dependencies);
      for (const stage of [
        { ...request.stage, episodeId: "missing-episode" },
        {
          ...request.stage,
          outline: { ...request.stage.outline, artifactId: "missing-outline" },
        },
      ]) {
        const wrong = { ...request, stage };
        await assert.rejects(
          app.startProjectTurn(f.actor, wrong, f.authority, {
            projectReadScope: scope(wrong),
          }),
          (error) =>
            error instanceof ApplicationError && error.category === "conflict",
        );
      }
      await assert.rejects(
        app.startProjectTurn(f.actor, request, f.authority, {
          projectReadScope: { ...scope() },
        }),
      );
      const missing = new ProjectConversationApplicationService({
        ...dependencies,
        texts: {
          loadOutline: texts.loadOutline.bind(texts),
          loadRevision: texts.loadRevision.bind(texts),
          loadOutlineSourceRevision:
            texts.loadOutlineSourceRevision.bind(texts),
        },
      });
      await assert.rejects(
        missing.startProjectTurn(f.actor, request, f.authority, {
          projectReadScope: scope(),
        }),
        (error) =>
          error instanceof ApplicationError &&
          error.code === "project_conversation_text_read_binding_unavailable",
      );
      const started = await app.startProjectTurn(
        f.actor,
        request,
        f.authority,
        { projectReadScope: scope() },
      );
      assert.equal(
        started.stageAdmission.sources.outline?.contentDigest,
        saved.contentRevision!.contentDigest,
      );
      assert.equal(started.result.turn.messages[0]!.content, request.content);
      const replay = await new ProjectConversationApplicationService(
        dependencies,
      ).startProjectTurn(f.actor, request, f.authority, {
        projectReadScope: scope(),
      });
      assert.equal(replay.result.binding.runId, started.result.binding.runId);
      assert.deepEqual(replay.stageAdmission, started.stageAdmission);
      f.state.current = false;
      await assert.rejects(
        app.startProjectTurn(f.actor, request, f.authority, {
          projectReadScope: scope(),
        }),
      );
    },
  );
