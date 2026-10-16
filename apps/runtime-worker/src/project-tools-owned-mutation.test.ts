import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectStageRunAdmission } from "@crewon/domain";
import { projectToolsOwnerFixture } from "./project-tools-service-owner.test-support.ts";
import { conversationFixture } from "../../../packages/store/src/project-conversation-store.test-support.ts";
import { projectRunOwnedFixture } from "../../../packages/store/src/project-run-owned.test-support.ts";
import { projectToolBoundReadServices } from "./plugins/project-tool-bound-read-services.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 30_000,
  };
  test(
    `${backend}: genuine scoped script Tool saves and cold-replays plugin-owned text without ordinary access`,
    options,
    async (t) => {
      let stage: ProjectStageRunAdmission | null = null;
      const f = await projectToolsOwnerFixture(t, {
        backend,
        prepareAdmission: async (base) => {
          const c = await conversationFixture(t, backend, base),
            prepared = await c.prepare();
          await c.store.commitBinding(prepared, { authority: c.authority });
          const brief = await c.metadata.loadBrief({
            owner: {
              tenantId: c.actor.tenantId,
              spaceId: c.actor.spaceId,
              principalId: c.actor.principalId,
            },
            projectId: c.reference.projectId,
            briefRevision: 1,
          });
          assert.ok(brief);
          const accepted = await c.tasks.createProjectConversationTurnFromHost(
            c.actor,
            {
              pluginId: c.pin.pluginId,
              threadId: prepared.binding.threadId,
              expectedThreadRevision: 1,
              idempotencyKey: "owned-script-turn",
              intent: { kind: "generate", input: { prompt: "write script" } },
            },
            {
              binding: prepared.binding,
              stage: {
                kind: "script",
                episodeId: "ep1",
                briefRevision: 1,
                outline: null,
              },
              sources: {
                brief: { briefRevision: 1, contentDigest: brief.contentDigest },
                outline: null,
              },
              content: "write script",
              authority: c.authority,
              conversations: c.store,
            },
          );
          stage = accepted.stageAdmission;
          return accepted.result;
        },
        stageAdmission: () => stage,
      });
      assert.ok(stage);
      const request = {
        projectId: f.reference.projectId,
        episodeId: "ep1",
        expectedArtifactRevision: 0,
        briefRevision: 1,
        outline: null,
        content: {
          title: "来信",
          scenes: [
            {
              sceneId: "s1",
              location: "暗房",
              timeOfDay: "夜",
              action: "展开底片",
              dialogue: [{ speaker: "修复师", text: "原稿对白" }],
            },
          ],
        },
      };
      const op = await f.prepareOperation("script_save", request, stage);
      const ownerScope = {
        ...f.actor,
        profileId: f.admission.profileId,
        pluginId: f.admission.pluginId,
        publisherId: f.admission.publisherId,
      };
      await projectRunOwnedFixture(t, {
        backend,
        path: f.databasePath,
        prefix: f.prefix,
        stage,
        owner: ownerScope,
      });
      const owner = () =>
        f.owner({
          projectOwnership: "plugin-project-v1",
          readServices: (scope) =>
            projectToolBoundReadServices(
              { store: f.parent, authorization: f.dependencies.authorization },
              scope,
            ),
        });
      const resident = owner();
      const saved = await f.invoke(resident, op, (command) =>
        f.service(resident).saveScriptCandidate({ command, request }),
      );
      assert.equal(saved.disposition, "committed");
      assert.equal(saved.contentRevision?.kind, "script");
      const before = await f.counts();
      assert.equal(before.project_text_revisions, 1);
      await resident.close();
      const cold = owner();
      const replay = await f.invoke(cold, op, (command) =>
        f.service(cold).saveScriptCandidate({ command, request }),
      );
      assert.deepEqual({ ...replay, disposition: "committed" }, saved);
      assert.deepEqual(await f.counts(), before);
      assert.equal(
        await f.texts.loadScript({
          owner: {
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            principalId: f.actor.principalId,
          },
          projectId: request.projectId,
          episodeId: request.episodeId,
        }),
        null,
      );
      await assert.rejects(
        f.text.saveScriptCandidate(f.actor, {
          ...request,
          idempotencyKey: "ordinary-cannot-borrow",
        }),
      );
      await assert.rejects(
        f.invoke(
          cold,
          op,
          (command) =>
            f.service(cold).saveScriptCandidate({ command, request }),
          { copied: true },
        ),
      );
      const expired = f.owner({
        projectOwnership: "plugin-project-v1",
        now: () => new Date(Date.parse(op.claim.lease.expiresAt) + 1),
      });
      await assert.rejects(
        f.invoke(expired, op, (command) =>
          f.service(expired).saveScriptCandidate({ command, request }),
        ),
      );
      f.state.policy = false;
      await assert.rejects(
        f.invoke(cold, op, (command) =>
          f.service(cold).saveScriptCandidate({ command, request }),
        ),
      );
      f.state.policy = true;
      assert.deepEqual(await f.counts(), before);
    },
  );
}
