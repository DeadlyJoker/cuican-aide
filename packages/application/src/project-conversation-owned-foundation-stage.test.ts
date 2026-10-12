import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PROJECT_CONVERSATIONS_METHOD_ACTIONS as actions } from "@crewon/contracts/project-conversations";
import { ProjectConversationApplicationService } from "./project-conversation-application-service.ts";
import { issuePluginProjectConversationStageReadScope } from "./host-project-workspaces.ts";
import { conversationFixture } from "../../store/src/project-conversation-store.test-support.ts";
import { foundationCreationRecipe } from "../../store/src/project-foundation-store.test-support.ts";
import { foundationMetadataFixture } from "../../store/src/project-foundation-legacy-access.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: original protected discussion Task creates paired Foundation facts atomically and cold replays one Run`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await conversationFixture(t, backend);
      const foundations = f.parent.projectFoundationStore({
        sourceAdmission: "trusted-internal-recipe",
      });
      await foundations.migrate();
      const created = await foundations.commitCreation(
        foundationCreationRecipe(
          "protected-stage-foundation",
          "stage-foundation-create",
          "novel",
          f.actor,
        ),
      );
      // Canonical source and original creation before the negative ownership constraint.
      f.reference.projectId = created.project.projectId;
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
      await metadata.mark(created.project.projectId, owner);
      const dependencies = {
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
      const request = {
        projectId: created.project.projectId,
        threadId: prepared.binding.threadId,
        expectedThreadRevision: 1,
        expectedBindingRevision: 1,
        stage: { kind: "discussion" as const },
        content: "读取原基础资料并讨论改编",
        idempotencyKey: "protected-foundation-stage",
      };
      const scope = () =>
        issuePluginProjectConversationStageReadScope({
          authority: f.authority,
          request: { action: actions.startStage, input: request },
        });
      const app = new ProjectConversationApplicationService(dependencies);
      await assert.rejects(
        app.startProjectTurn(f.actor, request, f.authority, {
          projectReadScope: { ...scope() },
        }),
      );
      const started = await app.startProjectTurn(
        f.actor,
        request,
        f.authority,
        { projectReadScope: scope() },
      );
      const replay = await new ProjectConversationApplicationService(
        dependencies,
      ).startProjectTurn(f.actor, request, f.authority, {
        projectReadScope: scope(),
      });
      assert.equal(replay.result.binding.runId, started.result.binding.runId);
      const rows = await f.rows(
        `SELECT record_json FROM ${f.prefix}project_foundation_run_admissions`,
      );
      assert.equal(rows.length, 1);
      const record =
        typeof rows[0]!.record_json === "string"
          ? JSON.parse(rows[0]!.record_json)
          : rows[0]!.record_json;
      assert.equal(record.projectId, created.project.projectId);
      assert.equal(
        record.projectStageAdmissionDigest,
        started.stageAdmission.contentDigest,
      );
      assert.deepEqual(record.source, created.foundation.source);
      const markers = await f.rows(
        `SELECT content_digest FROM ${f.prefix}project_foundation_run_requirements`,
      );
      assert.equal(markers.length, 1);
      assert.equal(markers[0]!.content_digest, record.contentDigest);
      // Ordinary paired reader still cannot borrow these protected facts.
      await assert.rejects(
        f.parent
          .projectFoundationRunStore()
          .loadFoundationRunAdmission({
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            runId: started.result.binding.runId,
          }),
      );
    },
  );
