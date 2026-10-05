import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ProjectConversationApplicationService } from "./project-conversation-application-service.ts";
import { quoteExtensionTaskGeneration } from "./extension-task-credit-support.ts";
import type { ExtensionCreditQuotePort } from "./extension-credit-quote-port.ts";
import { conversationFixture } from "../../store/src/project-conversation-store.test-support.ts";

test("conversation quote uses the actual plain-message stage; a missing explicit capability never falls back to the legacy quote", async (t) => {
  const f = await conversationFixture(t, "sqlite");
  const texts = f.parent.projectTextStore();
  await texts.migrate();
  await f.first.store.migrateCredits();
  const app = new ProjectConversationApplicationService({
    conversations: f.store,
    threads: f.threads,
    threadStore: f.parent,
    projects: f.metadata,
    texts,
    tasks: f.tasks,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: f.dependencies.clock,
    ids: { nextId: () => randomUUID() },
    digester: f.digester,
  });
  const created = await app.createConversation(
    f.actor,
    {
      projectId: f.reference.projectId,
      workspaceId: "original-workspace",
      title: null,
      idempotencyKey: "quote-conversation-create",
    },
    f.authority,
  );
  const content =
    "Discuss the heroine's secret; keep this Message as plain text.";
  const started = await app.startProjectTurn(
    f.actor,
    {
      projectId: f.reference.projectId,
      threadId: created.binding.threadId,
      expectedThreadRevision: 1,
      expectedBindingRevision: 1,
      content,
      stage: { kind: "discussion" },
      idempotencyKey: "quote-stage-original",
    },
    f.authority,
  );
  const { binding } = started.result;
  const receipt = {
    actorId: f.actor.actorId,
    idempotencyKey: started.stageAdmission.idempotencyKey,
    requestDigest: started.stageAdmission.requestDigest,
  };
  const input = { prompt: content };
  const qualification = { projectStageAdmission: started.stageAdmission };
  let legacyCalls = 0,
    conversationCalls = 0;
  const quote = {
    poolId: "named-quote-policy",
    priceRevision: 1,
    quotedCredits: "30",
  };
  const legacyOnly: ExtensionCreditQuotePort = {
    async quoteGeneration(request) {
      legacyCalls++;
      assert.deepEqual(Object.keys(request).sort(), [
        "actor",
        "binding",
        "commandRequestDigest",
        "input",
      ]);
      return quote;
    },
  };
  const dependencies = {
    extensions: f.first.store,
    creditQuotes: legacyOnly,
    digester: f.digester,
  };
  await assert.rejects(
    quoteExtensionTaskGeneration(
      dependencies,
      f.actor,
      binding,
      receipt,
      input,
      qualification,
    ),
    /extension_project_conversation_credit_quote_unavailable/,
  );
  assert.equal(legacyCalls, 0);
  const explicit: ExtensionCreditQuotePort = {
    ...legacyOnly,
    async quoteProjectConversationGeneration(request) {
      assert.equal(this, explicit);
      conversationCalls++;
      assert.deepEqual(Object.keys(request).sort(), [
        "actor",
        "binding",
        "commandRequestDigest",
        "input",
        "projectStageAdmission",
      ]);
      assert.deepEqual(request.actor, f.actor);
      assert.deepEqual(request.binding, binding);
      assert.deepEqual(request.input, input);
      assert.deepEqual(request.projectStageAdmission, started.stageAdmission);
      assert.equal(
        request.commandRequestDigest,
        started.stageAdmission.requestDigest,
      );
      assert.equal(binding.inputDigest, f.digester.sha256(content));
      return quote;
    },
  };
  const funded = await quoteExtensionTaskGeneration(
    { ...dependencies, creditQuotes: explicit },
    f.actor,
    binding,
    receipt,
    input,
    qualification,
  );
  assert.equal(funded.bindingDigest, binding.bindingDigest);
  assert.equal(conversationCalls, 1);
  assert.equal(legacyCalls, 0);
  await quoteExtensionTaskGeneration(
    dependencies,
    f.actor,
    binding,
    receipt,
    input,
  );
  assert.equal(
    legacyCalls,
    1,
    "the unqualified old four-field method is unchanged",
  );
  assert.equal(conversationCalls, 1);
});
