import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROJECT_CONVERSATIONS_METHOD_ACTIONS as A,
  createPluginProjectConversationsClient,
} from "./plugin-project-conversations-service.ts";
import {
  parseProjectConversationsActionRequest as request,
  parseProjectConversationsActionResponse as response,
  projectConversationsCodec,
} from "./plugin-project-conversations-contract.ts";
import { parseProjectContextResponse } from "./plugin-project-context-contract.ts";
const digest = "sha256:" + "1".repeat(64),
  time = "2026-10-06T00:00:00.000Z";
const binding = {
  bindingId: "binding",
  projectId: "project",
  threadId: "thread",
  workspaceId: "workspace",
  revision: 1,
  state: "active",
  source: {
    pluginId: "crewon.short-drama",
    publisherId: "crewon",
    version: "16.0.0-alpha.1+build.1",
    packageDigest: digest,
    selectionRevision: 2,
  },
  createdAt: time,
  updatedAt: time,
};
test("seven exact operations capture detached inputs and preserve plain content", () => {
  const inputs = {
    getBinding: { threadId: "thread" },
    listConversations: { projectId: "project", afterThreadId: null, limit: 16 },
    createConversation: {
      projectId: "project",
      workspaceId: "workspace",
      title: null,
      idempotencyKey: "once",
    },
    openConversation: { projectId: "project", threadId: "thread" },
    refreshSource: {
      projectId: "project",
      threadId: "thread",
      expectedBindingRevision: 1,
      idempotencyKey: "once",
    },
    setState: {
      projectId: "project",
      threadId: "thread",
      expectedBindingRevision: 1,
      state: "revoked",
      idempotencyKey: "once",
    },
    startStage: {
      projectId: "project",
      threadId: "thread",
      expectedThreadRevision: 1,
      expectedBindingRevision: 1,
      content: "先讨论\n人物动机。",
      stage: { kind: "discussion" },
      idempotencyKey: "once",
    },
  };
  for (const [method, input] of Object.entries(inputs)) {
    const value = request({ action: A[method as keyof typeof A], input });
    assert.deepEqual(value.input, input);
    assert.ok(Object.isFrozen(value.input));
    assert.throws(() =>
      request({ action: value.action, input: { ...input, actorId: "forged" } }),
    );
  }
});
test("inputs reject getters, lone surrogates, raw byte overflow, invalid stage and repeated keys", () => {
  const input = {
    projectId: "project",
    threadId: "thread",
    expectedThreadRevision: 1,
    expectedBindingRevision: 1,
    content: "hello",
    stage: { kind: "discussion" },
    idempotencyKey: "once",
  };
  for (const patch of [
    { content: "\ud800" },
    { content: "汉".repeat(6000) },
    { content: "\0" },
    { stage: { kind: "discussion", briefRevision: 1 } },
    {
      stage: {
        kind: "script",
        episodeId: "episode",
        briefRevision: 1,
        outline: { artifactId: "outline", contentRevision: 0 },
      },
    },
    { idempotencyKey: "once,twice" },
    { projectId: ".." },
  ])
    assert.throws(() =>
      request({ action: A.startStage, input: { ...input, ...patch } }),
    );
  let called = false;
  const bad = Object.defineProperty({ ...input }, "content", {
    enumerable: true,
    get() {
      called = true;
      return "hello";
    },
  });
  assert.throws(() => request({ action: A.startStage, input: bad }));
  assert.equal(called, false);
});
test("response binds actual Thread CAS and source; unknown private fields are rejected", () => {
  const q = request({
    action: A.createConversation,
    input: {
      projectId: "project",
      workspaceId: "workspace",
      title: null,
      idempotencyKey: "once",
    },
  });
  assert.deepEqual(response(q, { disposition: "committed", binding }), {
    disposition: "committed",
    binding,
  });
  assert.throws(() =>
    response(q, {
      disposition: "committed",
      binding: { ...binding, ownerPrincipalId: "private" },
    }),
  );
  const start = request({
      action: A.startStage,
      input: {
        projectId: "project",
        threadId: "thread",
        expectedThreadRevision: 3,
        expectedBindingRevision: 1,
        content: "hi",
        stage: { kind: "discussion" },
        idempotencyKey: "once",
      },
    }),
    receipt = {
      disposition: "replayed",
      threadId: "thread",
      threadRevision: 4,
      runId: "run",
      runRevision: 1,
      bindingRevision: 1,
      stageAdmissionDigest: digest,
    };
  assert.deepEqual(response(start, receipt), receipt);
  for (const patch of [
    { threadRevision: 3 },
    { threadId: "other" },
    { bindingRevision: 2 },
    { runId: ".." },
  ])
    assert.throws(() => response(start, { ...receipt, ...patch }));
});
test("list projection enforces finite pages, duplicates and final-row cursor", () => {
  const q = request({
    action: A.listConversations,
    input: { projectId: "project", afterThreadId: null, limit: 1 },
  });
  assert.deepEqual(
    response(q, { bindings: [binding], nextThreadId: "thread" }),
    { bindings: [binding], nextThreadId: "thread" },
  );
  for (const out of [
    { bindings: [binding, binding], nextThreadId: null },
    { bindings: [binding], nextThreadId: "other" },
    { bindings: [{ ...binding, projectId: "other" }], nextThreadId: null },
  ])
    assert.throws(() => response(q, out));
});
test("portable client has zero imports and only explicit calls, no retry or fabricated response", async () => {
  assert.doesNotMatch(
    readFileSync(
      new URL("plugin-project-conversations-service.ts", import.meta.url),
      "utf8",
    ),
    /^import\s/m,
  );
  let calls = 0;
  const client = createPluginProjectConversationsClient(
    {
      invoke: async (action, input) => {
        calls++;
        assert.equal(action, A.openConversation);
        assert.deepEqual(input, { projectId: "project", threadId: "thread" });
        return { binding };
      },
    },
    projectConversationsCodec,
  );
  assert.deepEqual(
    await client.openConversation({ projectId: "project", threadId: "thread" }),
    { binding },
  );
  assert.equal(calls, 1);
  await assert.rejects(() =>
    client.openConversation({ projectId: "..", threadId: "thread" }),
  );
  assert.equal(calls, 1);
});
test("Node scope is exact and bounded; legacy null is distinct from malformed stage", () => {
  assert.deepEqual(parseProjectContextResponse({ scope: null }), {
    scope: null,
  });
  const scope = {
    projectId: "project",
    threadId: "thread",
    runId: "run",
    bindingId: "binding",
    bindingRevision: 1,
    stage: { kind: "outline", briefRevision: 1 },
    sources: {
      brief: { briefRevision: 1, contentDigest: digest },
      outline: null,
    },
    allowedOperations: [
      "project_context_read",
      "project_read",
      "outline_read",
      "script_read",
      "content_read",
      "text_history",
      "outline_save",
    ],
    contentDigest: digest,
  };
  assert.deepEqual(parseProjectContextResponse({ scope }), { scope });
  for (const patch of [
    { allowedOperations: [...scope.allowedOperations, "submit"] },
    { sources: { brief: null, outline: null } },
    { actorId: "private" },
    { contentDigest: "invalid" },
  ])
    assert.throws(() =>
      parseProjectContextResponse({ scope: { ...scope, ...patch } }),
    );
  assert.throws(() =>
    parseProjectContextResponse({ scope: null, grant: true }),
  );
});

test("conversation pages preserve ordered whole records and reject backwards cursors", () => {
  const q = request({
      action: A.listConversations,
      input: { projectId: "project", afterThreadId: "thread-a", limit: 16 },
    }),
    a = { ...binding, threadId: "thread-b" },
    b = { ...binding, threadId: "thread-c" };
  assert.deepEqual(
    response(q, { bindings: [a, b], nextThreadId: "thread-c" }),
    { bindings: [a, b], nextThreadId: "thread-c" },
  );
  assert.throws(() =>
    response(q, { bindings: [b, a], nextThreadId: "thread-b" }),
  );
  assert.throws(() =>
    response(q, {
      bindings: [{ ...a, threadId: "thread-0" }],
      nextThreadId: null,
    }),
  );
});

test("optional model selection preserves legacy bodies and rejects target injection and invalid model IDs", () => {
  const legacy = {
    projectId: "project",
    threadId: "thread",
    expectedThreadRevision: 1,
    expectedBindingRevision: 1,
    content: "创作",
    stage: { kind: "discussion" },
    idempotencyKey: "model-turn",
  };
  assert.deepEqual(
    request({ action: A.startStage, input: legacy }).input,
    legacy,
  );
  assert.deepEqual(
    request({
      action: A.startStage,
      input: { ...legacy, modelId: "gpt-5.6-sol" },
    }).input,
    { ...legacy, modelId: "gpt-5.6-sol" },
  );
  for (const modelId of [
    undefined,
    null,
    "",
    " sol",
    "sol\n",
    "x".repeat(257),
    "\ud800",
    { agentVersionId: "forged" },
  ])
    assert.throws(() =>
      request({ action: A.startStage, input: { ...legacy, modelId } }),
    );
  assert.throws(() =>
    request({
      action: A.startStage,
      input: { ...legacy, modelId: "sol", target: {} },
    }),
  );
  assert.throws(() =>
    request({
      action: A.openConversation,
      input: { projectId: "project", threadId: "thread", modelId: "sol" },
    }),
  );
});
