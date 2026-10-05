import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PROJECT_CONVERSATION_ASSOCIATION_ACTIONS as A } from "@crewon/contracts/project-conversation-association";
import { ProjectConversationApplicationService } from "./project-conversation-application-service.ts";
import { TurnApplicationService } from "./turn-application-service.ts";
import { conversationFixture } from "../../store/src/project-conversation-store.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  async function setup(t: test.TestContext) {
    const f = await conversationFixture(t, backend);
    const common = {
      conversations: f.store,
      threads: f.threads,
      threadStore: f.parent,
      projects: f.metadata,
      texts: f.parent.projectTextStore(),
      tasks: f.tasks,
      authorization: { authorize: async () => ({ outcome: "allow" as const }) },
      clock: f.dependencies.clock,
      ids: { nextId: () => randomUUID() },
      digester: f.digester,
    };
    const ordinary = await f.threads.createThread(f.actor, {
      kind: "thread.create",
      workspaceId: "ordinary-directory",
      title: "原始想法",
      idempotencyKey: randomUUID(),
    });
    const message = await f.threads.appendMessage(f.actor, {
      kind: "thread.message.append",
      threadId: ordinary.state.threadId,
      expectedRevision: ordinary.state.revision,
      content: "我想做一个雨夜修复师的悬疑短剧。",
      role: "user",
      idempotencyKey: randomUUID(),
    });
    const input = {
      projectId: f.reference.projectId,
      threadId: ordinary.state.threadId,
      workspaceId: "ordinary-directory",
      expectedThreadRevision: message.state.revision,
      idempotencyKey: "associate-once",
    };
    return {
      ...f,
      common,
      app: new ProjectConversationApplicationService(common),
      input,
    };
  }
  test(
    `${backend}: a prepared ordinary Turn cannot commit after association, while the explicit project stage still uses the original Thread`,
    options,
    async (t) => {
      const f = await setup(t);
      const ordinary = new TurnApplicationService({
        store: f.parent,
        authorization: f.common.authorization,
        clock: f.common.clock,
        ids: f.common.ids,
        digester: f.digester,
      });
      const prepared = await ordinary.prepareTurn(f.actor, {
        kind: "turn.start",
        threadId: f.input.threadId,
        expectedThreadRevision: f.input.expectedThreadRevision,
        content: "原会话里准备好的消息",
        idempotencyKey: "prepared-before-association",
        requestedAgentVersionId: null,
        executionIntent: "none",
        route: {
          authorityId: "authority-agent-1",
          runtimeGeneration: "ts-v0",
          agentVersionId: "agent-1",
          policySnapshotId: "policy-1",
          workspaceBindingId: null,
        },
      });
      await f.app.associateConversation(
        f.actor,
        { action: A.attach, input: f.input },
        f.authority,
      );
      await assert.rejects(
        () => f.parent.commitTurnStart(prepared),
        /project_conversation_scope_conflict/,
      );
      const current = await f.parent.loadThread({
        tenantId: f.actor.tenantId,
        threadId: f.input.threadId,
      });
      assert.equal(current?.revision, f.input.expectedThreadRevision);
      await f.common.texts.migrate();
      const stage = await f.app.startStage(
        f.actor,
        {
          projectId: f.input.projectId,
          threadId: f.input.threadId,
          expectedThreadRevision: f.input.expectedThreadRevision,
          expectedBindingRevision: 1,
          content: "在这个项目里继续讨论人物动机。",
          stage: { kind: "discussion" },
          idempotencyKey: "explicit-project-stage",
        },
        f.authority,
      );
      assert.equal(stage.threadId, f.input.threadId);
      assert.equal(stage.threadRevision, f.input.expectedThreadRevision + 1);
    },
  );
  test(
    `${backend}: existing ordinary Thread, workspace and history survive association and cold replay without a Run`,
    options,
    async (t) => {
      const f = await setup(t);
      const locator = {
        tenantId: f.actor.tenantId,
        threadId: f.input.threadId,
      };
      const before = await f.parent.loadThread(locator);
      const events = await f.parent.listThreadEvents(locator, 0, 100);
      const messages = await f.parent.listMessages(locator, 0, 100);
      const history = await f.parent.listModelHistoryItems(locator, 0, 100);
      const inspected = await f.app.associateConversation(
        f.actor,
        {
          action: A.inspect,
          input: { projectId: f.input.projectId, threadId: f.input.threadId },
        },
        f.authority,
      );
      assert.deepEqual(inspected, {
        candidate: {
          threadId: f.input.threadId,
          threadRevision: f.input.expectedThreadRevision,
          workspaceId: f.input.workspaceId,
        },
      });
      const created = await f.app.associateConversation(
        f.actor,
        { action: A.attach, input: f.input },
        f.authority,
      );
      assert.ok("binding" in created);
      assert.equal(created.binding.threadId, f.input.threadId);
      const cold = new ProjectConversationApplicationService(f.common);
      assert.deepEqual(
        await cold.associateConversation(
          f.actor,
          { action: A.attach, input: f.input },
          f.authority,
        ),
        { ...created, disposition: "replayed" },
      );
      assert.deepEqual(await f.parent.loadThread(locator), before);
      assert.deepEqual(
        await f.parent.listThreadEvents(locator, 0, 100),
        events,
      );
      assert.deepEqual(await f.parent.listMessages(locator, 0, 100), messages);
      assert.deepEqual(
        await f.parent.listModelHistoryItems(locator, 0, 100),
        history,
      );
      assert.equal(
        (await f.rows(`SELECT count(*) n FROM ${f.prefix}run_snapshots`))[0]?.n,
        backend === "sqlite" ? 0 : "0",
      );
      assert.equal(
        (
          await f.rows(
            `SELECT count(*) n FROM ${f.prefix}project_conversation_bindings`,
          )
        )[0]?.n,
        backend === "sqlite" ? 1 : "1",
      );
      assert.deepEqual(
        await cold.associateConversation(
          f.actor,
          {
            action: A.inspect,
            input: { projectId: f.input.projectId, threadId: f.input.threadId },
          },
          f.authority,
        ),
        { candidate: null },
      );
      await assert.rejects(
        () =>
          cold.associateConversation(
            f.actor,
            { action: A.attach, input: { ...f.input, workspaceId: null } },
            f.authority,
          ),
        /idempotency_conflict/,
      );
      await assert.rejects(
        () =>
          cold.associateConversation(
            f.actor,
            {
              action: A.attach,
              input: { ...f.input, idempotencyKey: "second-request" },
            },
            f.authority,
          ),
        /binding_conflict/,
      );
    },
  );
  test(
    `${backend}: association rejects stale revision, switched workspace, wrong actor and withdrawn authority before persistence`,
    options,
    async (t) => {
      const f = await setup(t);
      for (const patch of [
        { expectedThreadRevision: 1 },
        { workspaceId: null },
      ])
        await assert.rejects(
          () =>
            f.app.associateConversation(
              f.actor,
              { action: A.attach, input: { ...f.input, ...patch } },
              f.authority,
            ),
          /thread_conflict/,
        );
      await assert.rejects(
        () =>
          f.app.associateConversation(
            { ...f.actor, actorId: "foreign" },
            { action: A.attach, input: f.input },
            f.authority,
          ),
        /authority_required/,
      );
      f.state.beforeTransaction = () => {
        f.state.current = false;
      };
      await assert.rejects(
        () =>
          f.app.associateConversation(
            f.actor,
            { action: A.attach, input: f.input },
            f.authority,
          ),
        /pdp_denied/,
      );
      assert.equal(
        await f.store.hasThreadBinding({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          threadId: f.input.threadId,
        }),
        false,
      );
    },
  );
  test(
    `${backend}: in-flight Run blocks association of its actual Thread without affecting execution`,
    options,
    async (t) => {
      const f = await setup(t);
      const started = await f.generate();
      const thread = await f.parent.loadThread({
        tenantId: f.actor.tenantId,
        threadId: f.command().threadId,
      });
      assert.ok(thread);
      const input = {
        ...f.input,
        threadId: thread.threadId,
        expectedThreadRevision: thread.revision,
        workspaceId: thread.workspaceId ?? null,
      };
      await assert.rejects(
        () =>
          f.app.associateConversation(
            f.actor,
            { action: A.attach, input },
            f.authority,
          ),
        /thread_busy_conflict/,
      );
      assert.equal(
        await f.store.hasThreadBinding({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          threadId: thread.threadId,
        }),
        false,
      );
      assert.equal(
        (
          await f.parent.loadRun({
            tenantId: f.actor.tenantId,
            runId: started.binding.runId,
          })
        )?.runId,
        started.binding.runId,
      );
    },
  );
}
