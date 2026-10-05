import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conversationFixture,
  observeStageCommit,
} from "./project-conversation-store.test-support.ts";
import { observeUnmeteredInsert } from "./plugin-task-unmetered.test-support.ts";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import {
  extensionCanonicalJson,
  type ProjectStageRunAdmission,
} from "@crewon/domain";
import { CreativeProjectApplicationService } from "@crewon/application";
import { projectRunCommitFixture } from "./creative-project-run-commit.test-support.ts";

function hasCause(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    (error.message === code || hasCause(code)(error.cause));
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: original admitted Turn/Run/queue/task plus stage commit atomically without balances or provider`,
    options,
    async (t) => {
      const f = await conversationFixture(t, backend),
        p = await f.prepare();
      await f.store.commitBinding(p, { authority: f.authority });
      const command = {
        pluginId: f.pin.pluginId,
        threadId: p.binding.threadId,
        expectedThreadRevision: 1,
        idempotencyKey: "stage-original",
        intent: {
          kind: "generate" as const,
          input: { prompt: "Discuss the saved project" },
        },
      };
      const task = {
        binding: p.binding,
        stage: { kind: "discussion" as const },
        sources: { brief: null, outline: null },
        content: command.intent.input.prompt,
        authority: f.authority,
        conversations: f.store,
      };
      const before = await f.creditObjects();
      const { result } = await f.tasks.createProjectConversationTurnFromHost(
        f.actor,
        command,
        task,
      );
      const locator = {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        runId: result.binding.runId,
      };
      const stage = await f.store.loadStageAdmission(locator);
      assert.ok(stage);
      assert.equal(stage.projectId, p.binding.projectId);
      assert.equal(stage.bindingRevision, 1);
      assert.equal(stage.workspaceId, p.binding.workspaceId);
      assert.equal(stage.threadId, result.turn.threadState.threadId);
      assert.equal(stage.runId, result.turn.runState.runId);
      const admission = await f.first.store.loadPluginTaskAdmission!(locator);
      assert.ok(admission);
      assert.equal(
        stage.pluginTaskAdmissionDigest,
        creativeStoreDigester.sha256(extensionCanonicalJson(admission)),
      );
      assert.equal(
        await f.store.readRequiredStageDigest(locator),
        stage.contentDigest,
      );
      assert.ok(result.unmeteredAdmission);
      assert.equal(result.creditAdmission, undefined);
      assert.deepEqual(
        await f.second.parent
          .projectConversationStore()
          .loadStageAdmission(locator),
        stage,
      );
      const { result: replay } =
        await f.tasks.createProjectConversationTurnFromHost(
          f.actor,
          command,
          task,
        );
      assert.equal(replay.run.state.runId, result.run.state.runId);
      assert.equal(replay.run.disposition, "replayed");
      assert.deepEqual(await f.creditObjects(), before);
      await assert.rejects(
        f
          .create()
          .createTaskFromPlugin(
            f.actor,
            { ...command, idempotencyKey: "raw-bound-task" },
            f.pin,
          ),
        hasCause("project_stage_admission_required"),
      );
    },
  );
  test(
    `${backend}: final stage fence rolls back original Run/Turn/admissions and thread revision`,
    options,
    async (t) => {
      const f = await conversationFixture(t, backend),
        p = await f.prepare();
      await f.store.commitBinding(p, { authority: f.authority });
      const restore = observeUnmeteredInsert(backend, () => {
        f.state.live = false;
      });
      t.after(restore);
      await assert.rejects(
        f.tasks.createProjectConversationTurnFromHost(
          f.actor,
          {
            pluginId: f.pin.pluginId,
            threadId: p.binding.threadId,
            expectedThreadRevision: 1,
            idempotencyKey: "withdraw-stage",
            intent: { kind: "generate", input: { prompt: "Do not commit" } },
          },
          {
            binding: p.binding,
            stage: { kind: "discussion" },
            sources: { brief: null, outline: null },
            content: "Do not commit",
            authority: f.authority,
            conversations: f.store,
          },
        ),
        hasCause("named_project_conversation_owner_withdrawn"),
      );
      assert.equal(
        (
          await f.parent.loadThread({
            tenantId: f.actor.tenantId,
            threadId: p.binding.threadId,
          })
        )?.revision,
        1,
      );
      const pfx = f.prefix;
      for (const table of [
        "run_snapshots",
        "plugin_task_admissions",
        "plugin_task_unmetered_admissions",
        "project_stage_run_admissions",
      ])
        assert.equal(
          Number(
            (await f.rows(`SELECT COUNT(*) AS n FROM ${pfx}${table}`))[0]?.n,
          ),
          0,
        );
    },
  );
  test(
    `${backend}: accepted original stage replays historical source, new Turn requires current source and binding CAS`,
    options,
    async (t) => {
      const f = await conversationFixture(t, backend),
        p = await f.prepare();
      await f.store.commitBinding(p, { authority: f.authority });
      const brief = await f.metadata.loadBrief({
        owner: {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          principalId: f.actor.principalId,
        },
        projectId: f.reference.projectId,
        briefRevision: 1,
      });
      assert.ok(brief);
      const task = {
        binding: p.binding,
        stage: { kind: "outline" as const, briefRevision: 1 },
        sources: {
          brief: { briefRevision: 1, contentDigest: brief.contentDigest },
          outline: null,
        },
        content: "Draft an outline",
        authority: f.authority,
        conversations: f.store,
      };
      const command = {
        pluginId: f.pin.pluginId,
        threadId: p.binding.threadId,
        expectedThreadRevision: 1,
        idempotencyKey: "historical-stage",
        intent: { kind: "generate" as const, input: { prompt: task.content } },
      };
      const { result: first } =
        await f.tasks.createProjectConversationTurnFromHost(
          f.actor,
          command,
          task,
        );
      const projects = new CreativeProjectApplicationService({
        store: f.metadata,
        authorization: {
          async authorize() {
            return { outcome: "allow" as const };
          },
        },
        clock: { now: () => new Date().toISOString() },
        ids: {
          nextId: () => assert.fail("append must not mint project identity"),
        },
        digester: f.digester,
      });
      await projects.appendBrief(f.actor, {
        projectId: f.reference.projectId,
        expectedProjectRevision: f.reference.expectedProjectRevision,
        text: "New brief after the original accepted Turn",
        idempotencyKey: "new-brief",
      });
      assert.equal(
        (
          await f.tasks.createProjectConversationTurnFromHost(
            f.actor,
            command,
            task,
          )
        ).result.run.state.runId,
        first.run.state.runId,
      );
      await assert.rejects(
        f.tasks.createProjectConversationTurnFromHost(
          f.actor,
          {
            ...command,
            expectedThreadRevision: first.turn.threadState.revision,
            idempotencyKey: "stale-new-turn",
          },
          task,
        ),
        hasCause("project_stage_sources_stale"),
      );
      const refresh = f.mutate(p.binding, "refresh-source");
      await f.store.commitBinding(refresh, { authority: f.authority });
      await assert.rejects(
        f.tasks.createProjectConversationTurnFromHost(f.actor, command, {
          ...task,
          binding: refresh.binding,
        }),
        hasCause("project_stage_admission_invalid"),
      );
      assert.equal(
        Number(
          (
            await f.rows(
              `SELECT COUNT(*) AS n FROM ${f.prefix}project_stage_run_admissions`,
            )
          )[0]?.n,
        ),
        1,
      );
    },
  );
  test(
    `${backend}: actual Run/Tool/claim writes only admitted project stage, missing scope and revoked binding refuse replay`,
    options,
    async (t) => {
      let admittedStage: ProjectStageRunAdmission | undefined;
      let conversation:
        | Awaited<ReturnType<typeof conversationFixture>>
        | undefined;
      let binding:
        | Awaited<
            ReturnType<
              Awaited<ReturnType<typeof conversationFixture>>["prepare"]
            >
          >["binding"]
        | undefined;
      const f = await projectRunCommitFixture(t, backend, async (base) => {
        conversation = await conversationFixture(t, backend, base);
        const p = await conversation.prepare();
        binding = p.binding;
        await conversation.store.commitBinding(p, {
          authority: conversation.authority,
        });
        const brief = await base.metadata.loadBrief({
          owner: {
            tenantId: base.actor.tenantId,
            spaceId: base.actor.spaceId,
            principalId: base.actor.principalId,
          },
          projectId: base.reference.projectId,
          briefRevision: 1,
        });
        assert.ok(brief);
        const result =
          await conversation.tasks.createProjectConversationTurnFromHost(
            base.actor,
            {
              pluginId: base.pin.pluginId,
              threadId: p.binding.threadId,
              expectedThreadRevision: 1,
              idempotencyKey: "tool-stage",
              intent: {
                kind: "generate",
                input: { prompt: "Draft outline with project tools" },
              },
            },
            {
              binding: p.binding,
              stage: { kind: "outline", briefRevision: 1 },
              sources: {
                brief: { briefRevision: 1, contentDigest: brief.contentDigest },
                outline: null,
              },
              content: "Draft outline with project tools",
              authority: conversation.authority,
              conversations: conversation.store,
            },
          );
        admittedStage =
          (await conversation.store.loadStageAdmission({
            tenantId: base.actor.tenantId,
            spaceId: base.actor.spaceId,
            runId: result.result.binding.runId,
          })) ?? undefined;
        assert.ok(admittedStage);
        return result.result;
      });
      assert.ok(admittedStage);
      assert.ok(conversation);
      assert.ok(binding);
      const outline = {
        title: "Outline",
        logline: "A shared project",
        synopsis: "An admitted stage proposes a candidate.",
        episodes: [
          { episodeId: "ep-1", title: "First", summary: "Saved source" },
        ],
      };
      const request = {
        projectId: f.reference.projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: outline,
      };
      const missing = await f.prepareOperation("outline_save", request);
      await assert.rejects(
        f.text.saveOutlineCandidate(
          f.actor,
          missing.commandBody as never,
          missing.options,
        ),
        hasCause("project_stage_tool_qualification_denied"),
      );
      const op = await f.prepareOperation(
        "outline_save",
        request,
        admittedStage,
      );
      const saved = await f.text.saveOutlineCandidate(
        f.actor,
        op.commandBody as never,
        op.options,
      );
      assert.equal(saved.disposition, "committed");
      const refreshed = conversation.mutate(binding, "refresh-source");
      await conversation.store.commitBinding(refreshed, {
        authority: conversation.authority,
      });
      assert.equal(
        (
          await f.text.saveOutlineCandidate(
            f.actor,
            op.commandBody as never,
            op.options,
          )
        ).disposition,
        "replayed",
      );
      const denied = await f.prepareOperation(
        "brief_append",
        {
          projectId: f.reference.projectId,
          expectedProjectRevision: f.reference.expectedProjectRevision,
          text: "Not admitted by outline stage",
        },
        admittedStage,
      );
      await assert.rejects(
        f.projects.appendBrief(
          f.actor,
          denied.commandBody as never,
          denied.options,
        ),
        hasCause("project_stage_admission_invalid"),
      );
      const revoked = conversation.mutate(refreshed.binding, "set-state");
      await conversation.store.commitBinding(revoked, {
        authority: conversation.authority,
      });
      await assert.rejects(
        f.text.saveOutlineCandidate(
          f.actor,
          op.commandBody as never,
          op.options,
        ),
        hasCause("project_stage_tool_qualification_denied"),
      );
      assert.equal((await f.counts()).project_text_revisions, 1);
      assert.deepEqual(await f.creditObjects(), []);
    },
  );
  test(
    `${backend}: withdrawal after confirmed original COMMIT returns the committed receipt without a false failure`,
    options,
    async (t) => {
      const f = await conversationFixture(t, backend),
        p = await f.prepare();
      await f.store.commitBinding(p, { authority: f.authority });
      const restore = observeStageCommit(backend, () => {
        f.state.live = false;
      });
      t.after(restore);
      const { result, stageAdmission } =
        await f.tasks.createProjectConversationTurnFromHost(
          f.actor,
          {
            pluginId: f.pin.pluginId,
            threadId: p.binding.threadId,
            expectedThreadRevision: 1,
            idempotencyKey: "confirmed-before-withdrawal",
            intent: {
              kind: "generate",
              input: { prompt: "Original committed discussion" },
            },
          },
          {
            binding: p.binding,
            stage: { kind: "discussion" },
            sources: { brief: null, outline: null },
            content: "Original committed discussion",
            authority: f.authority,
            conversations: f.store,
          },
        );
      assert.equal(f.state.live, false);
      assert.equal(result.run.disposition, "committed");
      assert.equal(stageAdmission.runId, result.binding.runId);
      assert.deepEqual(
        await f.second.parent.projectConversationStore().loadStageAdmission({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: result.binding.runId,
        }),
        stageAdmission,
      );
    },
  );
}
