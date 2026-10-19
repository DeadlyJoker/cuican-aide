import assert from "node:assert/strict";
import test from "node:test";
import {
  projectConversationCreationContextCapability,
  resolveProjectConversationWorkspace,
} from "../src/project-conversation-creation-context.ts";

const contextAction = "crewon.project-workspace-target.v1.getCreationContext";
const targetAction = "crewon.project-workspace-target.v1.resolveTarget";
const schemaVersion = "crewon.project-conversation-creation-context.v1";
const target = {
  projectId: "existing-project",
  workspaceId: "workspace-project-" + "a".repeat(64),
};
const options = (creationContext = "v1") => ({
  signal: new AbortController().signal,
  creationContext,
});

test("only the explicit versioned Host marker enables the new read", () => {
  assert.equal(
    projectConversationCreationContextCapability({
      hostPresentation: { projectConversationCreationContext: "v1" },
    }),
    "v1",
  );
  for (const data of [
    null,
    {},
    { hostPresentation: {} },
    { hostPresentation: { projectConversationCreationContext: "v2" } },
    {
      hostPresentation: Object.create({
        projectConversationCreationContext: "v1",
      }),
    },
  ])
    assert.equal(projectConversationCreationContextCapability(data), null);
  let reads = 0;
  const data = {
    get hostPresentation() {
      ++reads;
      return { projectConversationCreationContext: "v1" };
    },
  };
  assert.equal(projectConversationCreationContextCapability(data), null);
  assert.equal(reads, 0);
});

test("old Hosts retain the unchanged explicit project-workspace target protocol", async () => {
  const calls = [];
  const result = await resolveProjectConversationWorkspace(
    {
      async invoke(action, input) {
        calls.push({ action, input });
        return target;
      },
    },
    { projectId: target.projectId },
    options(null),
  );
  assert.deepEqual(calls, [
    { action: targetAction, input: { projectId: target.projectId } },
  ]);
  assert.deepEqual(result, target);
});

test("a real explicit legacy response resolves nullable workspace without guessing a namespace", async () => {
  const calls = [];
  const result = await resolveProjectConversationWorkspace(
    {
      async invoke(action, input) {
        calls.push({ action, input });
        return { schemaVersion, workspaceMode: "legacy-nullable" };
      },
    },
    { projectId: target.projectId },
    options(),
  );
  assert.deepEqual(calls, [{ action: contextAction, input: {} }]);
  assert.deepEqual(result, {
    projectId: target.projectId,
    workspaceId: null,
    workspaceMode: "legacy-nullable",
  });
  assert.equal(Object.isFrozen(result), true);
});

test("owned mode still resolves and validates the original explicit workspace", async () => {
  const calls = [];
  const result = await resolveProjectConversationWorkspace(
    {
      async invoke(action, input) {
        calls.push({ action, input });
        return action === contextAction
          ? { schemaVersion, workspaceMode: "plugin-owned-explicit" }
          : target;
      },
    },
    { projectId: target.projectId },
    options(),
  );
  assert.deepEqual(calls, [
    { action: contextAction, input: {} },
    { action: targetAction, input: { projectId: target.projectId } },
  ]);
  assert.deepEqual(result, target);
});

test("denied, unavailable or invalid context never falls back to a workspace hint", async () => {
  for (const response of [
    null,
    {},
    { schemaVersion, workspaceMode: "legacy" },
    { schemaVersion, workspaceMode: "legacy-nullable", extra: true },
    Object.create({ schemaVersion, workspaceMode: "legacy-nullable" }),
    { schemaVersion: "v2", workspaceMode: "legacy-nullable" },
  ]) {
    const calls = [];
    await assert.rejects(
      resolveProjectConversationWorkspace(
        {
          async invoke(action) {
            calls.push(action);
            return response;
          },
        },
        { projectId: target.projectId },
        options(),
      ),
      /creation_context_invalid/,
    );
    assert.deepEqual(calls, [contextAction]);
  }
  for (const code of [
    "plugin_ui_action_denied",
    "plugin_ui_service_unavailable",
  ]) {
    const error = Object.assign(new Error(code), { code });
    const calls = [];
    await assert.rejects(
      resolveProjectConversationWorkspace(
        {
          async invoke(action) {
            calls.push(action);
            throw error;
          },
        },
        { projectId: target.projectId },
        options(),
      ),
      (e) => e === error,
    );
    assert.deepEqual(calls, [contextAction]);
  }
});

test("withdrawal after the original read prevents a late owned workspace resolve", async () => {
  const controller = new AbortController(),
    calls = [];
  const reason = new Error("original_owner_withdrawn");
  await assert.rejects(
    resolveProjectConversationWorkspace(
      {
        async invoke(action) {
          calls.push(action);
          controller.abort(reason);
          return { schemaVersion, workspaceMode: "plugin-owned-explicit" };
        },
      },
      { projectId: target.projectId },
      { signal: controller.signal, creationContext: "v1" },
    ),
    (e) => e === reason,
  );
  assert.deepEqual(calls, [contextAction]);
});
