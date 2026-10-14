import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { conversationFixture } from "../../store/src/project-conversation-store.test-support.ts";
import { ProjectConversationApplicationService } from "./project-conversation-application-service.ts";
import { ProjectTextApplicationService } from "./project-text-application-service.ts";
import { CreativeProjectApplicationService } from "./creative-project-application-service.ts";

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: composer context keeps adopted outline instead of latest candidate and removes stale sources`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await conversationFixture(t, backend);
      const texts = f.parent.projectTextStore();
      await texts.migrate();
      const authority = {
        authorization: {
          authorize: async () => ({ outcome: "allow" as const }),
        },
        clock: f.dependencies.clock,
        ids: { nextId: () => randomUUID() },
        digester: f.digester,
      };
      const textService = new ProjectTextApplicationService({
        ...authority,
        store: texts,
        projects: f.metadata,
      });
      const service = new ProjectConversationApplicationService({
        ...authority,
        conversations: f.store,
        threads: f.threads,
        threadStore: f.parent,
        projects: f.metadata,
        texts,
        tasks: f.tasks,
      });
      const created = await service.createConversation(
        f.actor,
        {
          projectId: f.reference.projectId,
          workspaceId: "actual-workspace",
          title: null,
          idempotencyKey: "composer-context-create",
        },
        f.authority,
      );
      const read = () =>
        service.getContext(
          f.actor,
          { threadId: created.binding.threadId },
          f.authority,
        );
      assert.equal((await read()).context!.outline, null);
      const command = {
        projectId: f.reference.projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: {
          title: "已采纳方案",
          logline: "收到未来来信",
          synopsis: "修复师面对选择",
          episodes: [
            {
              episodeId: "actual-episode",
              title: "第一集",
              summary: "未来的信到了",
            },
          ],
        },
        idempotencyKey: "composer-outline-save",
      };
      const candidate = await textService.saveOutlineCandidate(
        f.actor,
        command,
      );
      assert.equal((await read()).context!.outline, null);
      await textService.selectRevision(f.actor, {
        projectId: command.projectId,
        artifactId: candidate.artifact.artifactId,
        expectedArtifactRevision: 1,
        contentRevision: 1,
        idempotencyKey: "composer-outline-adopt",
      });
      await textService.saveOutlineCandidate(f.actor, {
        ...command,
        expectedArtifactRevision: 2,
        content: {
          ...command.content,
          episodes: [
            {
              episodeId: "unadopted",
              title: "未采纳的集",
              summary: "尚未决定",
            },
          ],
        },
        idempotencyKey: "composer-outline-new-candidate",
      });
      assert.deepEqual((await read()).context!.outline, {
        artifactId: candidate.artifact.artifactId,
        contentRevision: 1,
        episodes: [{ episodeId: "actual-episode", title: "第一集" }],
      });
      const project = await f.metadata.loadProject({
        owner: {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          principalId: f.actor.principalId,
        },
        projectId: command.projectId,
      });
      await new CreativeProjectApplicationService({
        ...authority,
        store: f.metadata,
      }).appendBrief(f.actor, {
        projectId: command.projectId,
        expectedProjectRevision: project!.revision,
        text: "用户改变了创作需求",
        idempotencyKey: "composer-brief-change",
      });
      const changed = (await read()).context!;
      assert.equal(changed.briefRevision, 2);
      assert.equal(changed.outline, null);
    },
  );
