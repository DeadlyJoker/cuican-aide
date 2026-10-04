import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBindOfficeThreadRequest,
  parseCreateOfficeThreadRequest,
  parseOfficeThreadResponse,
  parseOfficeThreadMutationResponse,
} from "./office-thread-contract.ts";
const version = "office-version-1";
const thread = {
  threadId: "thread-1",
  title: "History",
  status: "active",
  revision: 2,
  lastMessageSequence: 1,
  forkedFromThreadId: null,
  forkedThroughHistorySequence: null,
  createdAt: "2026-09-14T00:00:00Z",
  updatedAt: "2026-09-14T00:00:01Z",
  archivedAt: null,
  deletedAt: null,
};
const snapshot = { officeId: "office-1", officeVersionId: version, thread };

test("Office association commands accept only a server-owned create and an explicit revision-bound claim", () => {
  assert.deepEqual(parseCreateOfficeThreadRequest({}), {});
  for (const invalid of [
    null,
    [],
    { threadId: "thread-1" },
    { title: "spoofed" },
    { tenantId: "other" },
  ])
    assert.throws(() => parseCreateOfficeThreadRequest(invalid));
  assert.deepEqual(
    parseBindOfficeThreadRequest({ threadId: "thread-1", expectedRevision: 2 }),
    { threadId: "thread-1", expectedRevision: 2 },
  );
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null])
    assert.throws(() =>
      parseBindOfficeThreadRequest({
        threadId: "thread-1",
        expectedRevision: invalid,
      }),
    );
  for (const invalid of [
    { threadId: "", expectedRevision: 1 },
    { threadId: "thread-1", expectedRevision: 1, tenantId: "other" },
  ])
    assert.throws(() => parseBindOfficeThreadRequest(invalid));
});

test("association responses validate Office identity, bounded Thread metadata, and mutation disposition", () => {
  assert.deepEqual(parseOfficeThreadResponse(snapshot, version), {
    ...snapshot,
    thread: { ...thread, workspaceId: null },
  });
  assert.equal(
    parseOfficeThreadResponse({ ...snapshot, thread: null }, version).thread,
    null,
  );
  for (const invalid of [
    { ...snapshot, officeVersionId: "other" },
    { ...snapshot, officeId: "" },
    { ...snapshot, tenantId: "other" },
    { ...snapshot, thread: { ...thread, title: "x".repeat(257) } },
    { ...snapshot, thread: { ...thread, tenantId: "leak" } },
    {
      ...snapshot,
      thread: {
        ...thread,
        forkedFromThreadId: "parent",
        forkedThroughHistorySequence: 0,
      },
    },
  ])
    assert.throws(() => parseOfficeThreadResponse(invalid, version));
  for (const operation of ["create", "bind"] as const) {
    const expected = { officeVersionId: version, operation };
    const disposition = operation === "create" ? "created" : "bound";
    assert.equal(
      parseOfficeThreadMutationResponse({ ...snapshot, disposition }, expected)
        .disposition,
      disposition,
    );
    assert.equal(
      parseOfficeThreadMutationResponse(
        { ...snapshot, disposition: "existing" },
        expected,
      ).disposition,
      "existing",
    );
    for (const invalid of [
      {
        ...snapshot,
        disposition: operation === "create" ? "bound" : "created",
      },
      { ...snapshot, disposition, thread: null },
      { ...snapshot, disposition, history: [] },
    ])
      assert.throws(() => parseOfficeThreadMutationResponse(invalid, expected));
  }
});

test("Office association responses preserve explicit workspace ownership and normalize legacy absence without mutating input", () => {
  assert.equal(
    parseOfficeThreadResponse(snapshot, version).thread?.workspaceId,
    null,
  );
  assert.equal(Object.hasOwn(thread, "workspaceId"), false);
  for (const workspaceId of [null, "workspace-1"] as const) {
    const candidate = {
      ...snapshot,
      thread: { ...thread, workspaceId },
    };
    assert.deepEqual(parseOfficeThreadResponse(candidate, version), candidate);
    for (const operation of ["create", "bind"] as const) {
      const disposition = operation === "create" ? "created" : "bound";
      assert.deepEqual(
        parseOfficeThreadMutationResponse(
          { ...candidate, disposition },
          { officeVersionId: version, operation },
        ).thread,
        candidate.thread,
      );
    }
  }
});
