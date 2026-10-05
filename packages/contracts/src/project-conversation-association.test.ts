import test from "node:test";
import assert from "node:assert/strict";
import {
  PROJECT_CONVERSATION_ASSOCIATION_ACTIONS as A,
  parseProjectConversationAssociationRequest as request,
  parseProjectConversationAssociationResponse as response,
  isProjectConversationUiNamespaceAction,
} from "./project-conversation-association.ts";
const input = {
  projectId: "project",
  threadId: "thread",
  expectedThreadRevision: 3,
  workspaceId: "original-workspace",
  idempotencyKey: "once",
};
const binding = {
  bindingId: "binding",
  projectId: "project",
  threadId: "thread",
  workspaceId: "original-workspace",
  revision: 1,
  state: "active",
  source: {
    pluginId: "test.short-drama",
    publisherId: "test",
    version: "20.0.0",
    packageDigest: "sha256:" + "a".repeat(64),
    selectionRevision: 1,
  },
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z",
};
test("malformed conversation namespace members stay with the metadata owner", () => {
  for (const namespace of [
    "crewon.project-conversations",
    "crewon.project-conversation-association",
  ]) {
    for (const suffix of ["", ".unknown", ".v2.attach", ".v1.unknown"])
      assert.equal(
        isProjectConversationUiNamespaceAction(namespace + suffix),
        true,
      );
    assert.equal(
      isProjectConversationUiNamespaceAction(namespace + "-other.v1.attach"),
      false,
    );
  }
  assert.equal(isProjectConversationUiNamespaceAction("image.generate"), false);
});
test("association is a detached, exact, bounded independent metadata command", () => {
  const value = request({ action: A.attach, input });
  assert.deepEqual(value.input, input);
  assert.ok(Object.isFrozen(value.input));
  for (const patch of [
    { expectedThreadRevision: 0 },
    { expectedThreadRevision: 1.5 },
    { workspaceId: undefined },
    { projectId: ".." },
    { actorId: "forged" },
    { runId: "forged" },
    { execute: true },
    { idempotencyKey: "a,b" },
  ])
    assert.throws(() =>
      request({ action: A.attach, input: { ...input, ...patch } }),
    );
  let reads = 0;
  assert.throws(() =>
    request({
      action: A.attach,
      input: Object.defineProperty({ ...input }, "workspaceId", {
        enumerable: true,
        get() {
          reads++;
          return null;
        },
      }),
    }),
  );
  assert.equal(reads, 0);
});
test("association results cannot retarget project, Thread, workspace or state", () => {
  const q = request({ action: A.attach, input });
  assert.deepEqual(response(q, { disposition: "replayed", binding }), {
    disposition: "replayed",
    binding,
  });
  for (const patch of [
    { projectId: "foreign" },
    { threadId: "foreign" },
    { workspaceId: null },
    { revision: 2 },
    { state: "revoked" },
    { grant: true },
  ])
    assert.throws(() =>
      response(q, {
        disposition: "committed",
        binding: { ...binding, ...patch },
      }),
    );
  assert.throws(() =>
    response(q, { disposition: "committed", binding, runId: "forged" }),
  );
});
test("association candidate is read metadata bound to the requested Thread", () => {
  const q = request({
    action: A.inspect,
    input: { projectId: "project", threadId: "thread" },
  });
  const candidate = {
    threadId: "thread",
    threadRevision: 3,
    workspaceId: null,
  };
  assert.deepEqual(response(q, { candidate }), { candidate });
  assert.deepEqual(response(q, { candidate: null }), { candidate: null });
  for (const patch of [
    { threadId: "foreign" },
    { threadRevision: 0 },
    { authority: true },
  ])
    assert.throws(() => response(q, { candidate: { ...candidate, ...patch } }));
});
