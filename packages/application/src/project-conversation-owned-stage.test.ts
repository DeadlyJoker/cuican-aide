import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PROJECT_CONVERSATIONS_METHOD_ACTIONS as actions } from "@crewon/contracts/project-conversations";
import { ProjectConversationApplicationService } from "./project-conversation-application-service.ts";
import { issuePluginProjectConversationStageReadScope } from "./host-project-workspaces.ts";
import { ownedConversationUiFixture } from "../../store/src/project-conversation-ui-owned.test-support.ts";

// Original SQL/Task writers and genuine UI. Installed snapshot and backend execution
// authority are named fixtures; this does not run a Worker or contact a model.
test("protected conversation stage commits and cold replays one original Run, while copied or changed read scopes fail before admission", async (t) => {
  const f = await ownedConversationUiFixture(t);
  const created = (await f.invoke(
    actions.createConversation,
    f.createInput,
  )) as {
    binding: { threadId: string };
  };
  const dependencies = {
    conversations: f.store,
    threads: f.threads,
    threadStore: f.parent,
    projects: f.parent.creativeProjectStore(),
    texts: f.parent.projectTextStore(),
    tasks: f.tasks,
    authorization: { authorize: async () => ({ outcome: "allow" as const }) },
    clock: f.dependencies.clock,
    ids: { nextId: () => randomUUID() },
    digester: f.digester,
  };
  await dependencies.texts.migrate();
  const request = {
    projectId: f.createInput.projectId,
    threadId: created.binding.threadId,
    expectedThreadRevision: 1,
    expectedBindingRevision: 1,
    stage: { kind: "discussion" as const },
    content: "隔离项目的原中央对话",
    idempotencyKey: "owned-original-stage",
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
  await assert.rejects(
    app.startProjectTurn(
      f.actor,
      { ...request, content: "changed" },
      f.authority,
      { projectReadScope: scope() },
    ),
  );
  const started = await app.startProjectTurn(f.actor, request, f.authority, {
    projectReadScope: scope(),
  });
  assert.equal(started.result.turn.messages[0]!.content, request.content);
  assert.equal(started.stageAdmission.projectId, request.projectId);
  assert.equal(
    started.result.turn.threadState.workspaceId,
    f.createInput.workspaceId,
  );
  const cold = new ProjectConversationApplicationService(dependencies);
  const replay = await cold.startProjectTurn(f.actor, request, f.authority, {
    projectReadScope: scope(),
  });
  assert.equal(replay.result.binding.runId, started.result.binding.runId);
  assert.deepEqual(replay.stageAdmission, started.stageAdmission);
  assert.equal(
    await f.store.readRequiredStageDigest({
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      runId: started.result.binding.runId,
    }),
    started.stageAdmission.contentDigest,
  );
});
