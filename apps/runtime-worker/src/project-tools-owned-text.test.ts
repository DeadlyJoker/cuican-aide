import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError } from "@crewon/application";
import type { ProjectStageRunAdmission } from "@crewon/domain";
import { projectToolsOwnerFixture } from "./project-tools-service-owner.test-support.ts";
import { conversationFixture } from "../../../packages/store/src/project-conversation-store.test-support.ts";
import { foundationMetadataFixture } from "../../../packages/store/src/project-foundation-legacy-access.test-support.ts";
import { projectToolBoundReadServices } from "./plugins/project-tool-bound-read-services.ts";

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: original Worker reads protected outline, script, immutable content and bounded history through original services`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      let stage: ProjectStageRunAdmission | null = null;
      const f = await projectToolsOwnerFixture(t, {
        backend,
        prepareAdmission: async (base) => {
          const c = await conversationFixture(t, backend, base);
          const prepared = await c.prepare();
          await c.store.commitBinding(prepared, { authority: c.authority });
          const accepted = await c.tasks.createProjectConversationTurnFromHost(
            c.actor,
            {
              pluginId: c.pin.pluginId,
              threadId: prepared.binding.threadId,
              expectedThreadRevision: 1,
              idempotencyKey: "text-read-stage",
              intent: {
                kind: "generate",
                input: { prompt: "inspect saved project" },
              },
            },
            {
              binding: prepared.binding,
              stage: { kind: "discussion" },
              sources: { brief: null, outline: null },
              content: "inspect saved project",
              authority: c.authority,
              conversations: c.store,
            },
          );
          stage = accepted.stageAdmission;
          return accepted.result;
        },
        stageAdmission: () => stage,
      });
      // Original manual commands create these artifacts before the negative owner constraint.
      // This proves qualified reads, not owned writes or actual installed-package execution.
      const projectId = f.reference.projectId;
      const outlineContent = {
        title: "夜航",
        logline: "来信",
        synopsis: "雨夜",
        episodes: [{ episodeId: "ep1", title: "第一集", summary: "暗号" }],
      };
      const first = await f.text.saveOutlineCandidate(f.actor, {
        projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: outlineContent,
        idempotencyKey: "manual-outline-one",
      });
      await f.text.selectRevision(f.actor, {
        projectId,
        artifactId: first.artifact.artifactId,
        expectedArtifactRevision: 1,
        contentRevision: 1,
        idempotencyKey: "manual-outline-selected",
      });
      await f.text.saveOutlineCandidate(f.actor, {
        projectId,
        expectedArtifactRevision: 2,
        briefRevision: 1,
        content: { ...outlineContent, title: "夜航第二稿" },
        idempotencyKey: "manual-outline-two",
      });
      const script = await f.text.saveScriptCandidate(f.actor, {
        projectId,
        episodeId: "ep1",
        expectedArtifactRevision: 0,
        briefRevision: 1,
        outline: { artifactId: first.artifact.artifactId, contentRevision: 1 },
        content: {
          title: "第一集",
          scenes: [
            {
              sceneId: "s1",
              location: "暗房",
              timeOfDay: "夜",
              action: "展开底片",
              dialogue: [{ speaker: "女主", text: "原稿对白" }],
            },
          ],
        },
        idempotencyKey: "manual-script",
      });
      await f.text.selectRevision(f.actor, {
        projectId,
        artifactId: script.artifact.artifactId,
        expectedArtifactRevision: 1,
        contentRevision: 1,
        idempotencyKey: "manual-script-selected",
      });
      const metadata = await foundationMetadataFixture(t, {
        backend,
        schema: backend === "postgres" ? f.prefix.slice(1, -2) : "main",
        prefix: f.prefix,
        path: f.databasePath,
      });
      await metadata.migrate();
      const ownerScope = {
        ...f.actor,
        profileId: f.admission.profileId,
        pluginId: f.admission.pluginId,
        publisherId: f.admission.publisherId,
      };
      await metadata.mark(projectId, ownerScope);
      const borrowedCalls: Promise<void>[] = [];
      const owner = f.owner({
        projectOwnership: "plugin-project-v1",
        readServices: (scope) => {
          const services = projectToolBoundReadServices(
            { store: f.parent, authorization: f.dependencies.authorization },
            scope,
          );
          borrowedCalls.push(
            assert.rejects(
              services.texts.getOutline(
                { ...f.actor, actorId: "other-actor" },
                { projectId },
              ),
              (error) =>
                error instanceof ApplicationError &&
                error.category === "authorization",
            ),
          );
          borrowedCalls.push(
            assert.rejects(
              services.texts.saveOutlineCandidate(f.actor, {
                projectId,
                expectedArtifactRevision: 0,
                briefRevision: 1,
                content: outlineContent,
                idempotencyKey: "read-cannot-write",
              }),
              (error) =>
                error instanceof ApplicationError &&
                error.category === "authorization",
            ),
          );
          return services;
        },
      });
      const request = { projectId };
      const operation = await f.prepareRead("readOutline", request);
      const view = await f.invoke(owner, operation, (command) =>
        f.service(owner).readOutline({ command, request }),
      );
      assert.equal(view.view?.artifact.artifactId, first.artifact.artifactId);
      assert.equal(view.view?.selectedRevision?.contentRevision, 1);
      await Promise.all(borrowedCalls);
      const scriptRequest = { projectId, episodeId: "ep1" };
      const scriptOp = await f.prepareRead("readScript", scriptRequest);
      const scriptView = await f.invoke(owner, scriptOp, (command) =>
        f.service(owner).readScript({ command, request: scriptRequest }),
      );
      assert.equal(
        scriptView.view?.artifact.artifactId,
        script.artifact.artifactId,
      );
      const contentRequest = {
        projectId,
        source: {
          kind: "text" as const,
          artifactId: script.artifact.artifactId,
          contentRevision: 1,
        },
        offset: 0,
      };
      const contentOp = await f.prepareRead("readContent", contentRequest);
      const content = await f.invoke(owner, contentOp, (command) =>
        f.service(owner).readContent({ command, request: contentRequest }),
      );
      assert.equal(content.format, "canonical-json");
      assert.ok(content.text.includes("原稿对白"));
      const historyRequest = {
        projectId,
        artifactId: first.artifact.artifactId,
        afterContentRevision: 0,
        limit: 1,
      };
      const historyOp = await f.prepareRead("listRevisions", historyRequest);
      const history = await f.invoke(owner, historyOp, (command) =>
        f.service(owner).listRevisions({ command, request: historyRequest }),
      );
      assert.equal(history.revisions.length, 1);
      assert.equal(history.nextContentRevision, 1);
      const counts = await f.counts();
      const unavailable = f.owner({ projectOwnership: "plugin-project-v1" });
      await assert.rejects(
        f.invoke(unavailable, operation, (command) =>
          f.service(unavailable).readOutline({ command, request }),
        ),
        /plugin_project_text_read_binding_unavailable/,
      );
      await assert.rejects(
        f.invoke(
          owner,
          operation,
          (command) => f.service(owner).readOutline({ command, request }),
          { copied: true },
        ),
      );
      await assert.rejects(
        f.invoke(owner, operation, (command) =>
          f.service(owner).readOutline({
            command,
            request: { projectId: "foreign-project" },
          }),
        ),
      );
      f.state.policy = false;
      await assert.rejects(
        f.invoke(owner, operation, (command) =>
          f.service(owner).readOutline({ command, request }),
        ),
      );
      f.state.policy = true;
      await owner.close();
      const cold = f.owner({
        projectOwnership: "plugin-project-v1",
        readServices: (scope) =>
          projectToolBoundReadServices(
            { store: f.parent, authorization: f.dependencies.authorization },
            scope,
          ),
      });
      assert.deepEqual(
        await f.invoke(cold, operation, (command) =>
          f.service(cold).readOutline({ command, request }),
        ),
        view,
      );
      assert.deepEqual(await f.counts(), counts);
      await Promise.all(borrowedCalls);
    },
  );
