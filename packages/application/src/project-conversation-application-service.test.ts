import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { CreativeProjectApplicationService } from "./creative-project-application-service.ts";
import { ProjectConversationApplicationService } from "./project-conversation-application-service.ts";
import { conversationFixture } from "../../store/src/project-conversation-store.test-support.ts";
const backends = ["sqlite", "postgres"] as const;
for (const backend of backends)
  test(
    `${backend}: actual conversation Thread creation, plain Stage Turn and cold same-key replay keep one immutable Run`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await conversationFixture(t, backend),
        common = {
          conversations: f.store,
          threads: f.threads,
          threadStore: f.parent,
          projects: f.metadata,
          texts: f.parent.projectTextStore(),
          tasks: f.tasks,
          authorization: {
            authorize: async () => ({ outcome: "allow" as const }),
          },
          clock: f.dependencies.clock,
          ids: { nextId: () => randomUUID() },
          digester: f.digester,
        };
      await common.texts.migrate();
      const app = new ProjectConversationApplicationService(common),
        request = {
          projectId: f.reference.projectId,
          workspaceId: "project-workspace",
          title: "项目创作对话",
          idempotencyKey: "conversation-create-original",
        };
      const created = await app.createConversation(
          f.actor,
          request,
          f.authority,
        ),
        cold = new ProjectConversationApplicationService(common),
        replay = await cold.createConversation(f.actor, request, {
          ...f.authority,
          pin: { ...f.authority.pin, authorityEpoch: "new-epoch" },
        });
      assert.equal(created.disposition, "committed");
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.binding, created.binding);
      assert.equal(created.binding.workspaceId, request.workspaceId);
      const open = await app.openConversation(
        f.actor,
        { projectId: request.projectId, threadId: created.binding.threadId },
        f.authority,
      );
      assert.deepEqual(open.binding, created.binding);
      const input = {
        projectId: request.projectId,
        threadId: created.binding.threadId,
        expectedThreadRevision: 1,
        expectedBindingRevision: 1,
        content: "先讨论女主的秘密，暂不生成媒体。",
        stage: { kind: "discussion" as const },
        idempotencyKey: "stage-original",
      };
      const started = await app.startProjectTurn(f.actor, input, f.authority);
      assert.equal(started.result.turn.messages[0]!.content, input.content);
      assert.equal(
        started.result.turn.threadState.workspaceId,
        request.workspaceId,
      );
      assert.equal(
        started.stageAdmission.userContentDigest,
        f.digester.sha256(input.content),
      );
      assert.equal(started.stageAdmission.stage.kind, "discussion");
      assert.ok(
        !started.stageAdmission.allowedOperations.includes("outline_save"),
      );
      assert.equal(
        await f.store.readRequiredStageDigest({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: started.result.binding.runId,
        }),
        started.stageAdmission.contentDigest,
      );
      await new CreativeProjectApplicationService({
        store: f.metadata,
        authorization: common.authorization,
        clock: common.clock,
        ids: common.ids,
        digester: common.digester,
      }).appendBrief(f.actor, {
        projectId: request.projectId,
        text: "人工编辑了新的需求。",
        expectedProjectRevision: f.reference.expectedProjectRevision,
        idempotencyKey: "manual-brief-after-commit",
      });
      const second = await cold.startProjectTurn(f.actor, input, {
        ...f.authority,
        pin: { ...f.authority.pin, authorityEpoch: "new-epoch" },
      });
      assert.equal(second.result.run.disposition, "replayed");
      assert.equal(second.result.binding.runId, started.result.binding.runId);
      assert.deepEqual(second.stageAdmission, started.stageAdmission);
      await assert.rejects(
        () =>
          app.startStage(
            f.actor,
            { ...input, content: "changed under same key" },
            f.authority,
          ),
        /project_stage_admission_invalid/,
      );
      const list = await app.listConversations(
        f.actor,
        { projectId: request.projectId, afterThreadId: null, limit: 16 },
        f.authority,
      );
      assert.equal(list.bindings.length, 1);
      assert.deepEqual(
        await app.getBinding(
          f.actor,
          { threadId: created.binding.threadId },
          f.authority,
        ),
        { binding: created.binding },
      );
      await assert.rejects(
        () =>
          app.getBinding(
            { ...f.actor, principalId: "foreign" },
            { threadId: created.binding.threadId },
            f.authority,
          ),
        /authority_required/,
      );
      const originalPrivateBinding = await f.store.loadBinding({
        actor: f.actor,
        profileId: f.installation.profileId,
        threadId: input.threadId,
      });
      assert.ok(originalPrivateBinding);
      await app.refreshSource(
        f.actor,
        {
          projectId: request.projectId,
          threadId: created.binding.threadId,
          expectedBindingRevision: 1,
          idempotencyKey: "refresh-source-after-accepted",
        },
        f.authority,
      );
      await assert.rejects(
        f.tasks.createProjectConversationTurnFromHost(
          f.actor,
          {
            pluginId: f.pin.pluginId,
            threadId: input.threadId,
            expectedThreadRevision: input.expectedThreadRevision,
            idempotencyKey: input.idempotencyKey,
            intent: { kind: "generate", input: { prompt: input.content } },
          },
          {
            binding: originalPrivateBinding,
            stage: started.stageAdmission.stage,
            sources: started.stageAdmission.sources,
            content: input.content,
            authority: f.authority,
            conversations: f.store,
          },
        ),
        /project_conversation_revision_conflict/,
      );
    },
  );
