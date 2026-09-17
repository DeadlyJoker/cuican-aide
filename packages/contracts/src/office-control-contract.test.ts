import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatOfficeCursor,
  parseCreateOfficeRequest,
  parseOfficeListQuery,
  parseStartOfficeRunRequest,
} from "./office-control-contract.ts";

test("round-trips a browser-safe canonical Office cursor", () => {
  const before = {
    createdAt: "2026-08-13T00:00:00.000Z",
    officeVersionId: "office-version-1",
  };
  const cursor = formatOfficeCursor(before);
  assert.deepEqual(parseOfficeListQuery({ cursor, limit: "25" }), {
    before,
    limit: 25,
  });
  assert.throws(
    () => parseOfficeListQuery({ cursor: `${cursor}x`, limit: "25" }),
    /office_cursor_invalid/,
  );
  assert.throws(
    () => parseOfficeListQuery({ before: cursor, limit: "25" }),
    /unknown_field/,
  );
});

test("requires at least one real Office execution target", () => {
  assert.throws(
    () =>
      parseCreateOfficeRequest({
        expectedRevision: 0,
        title: "Delivery",
        members: [],
        executionTargets: [],
      }),
    /office_collection_bounds_invalid/,
  );
});

test("accepts an optional bounded member responsibility and preserves legacy members", () => {
  const request = (member: Record<string, unknown>) =>
    parseCreateOfficeRequest({
      expectedRevision: 0,
      title: "Delivery",
      members: [member],
      executionTargets: [
        { targetId: "target-1", agentVersionId: "agent-version-1" },
      ],
    });
  const legacyMember = {
    memberId: "member-1",
    displayName: "Release lead",
    agentVersionId: "agent-version-1",
  };

  assert.deepEqual(request(legacyMember).members, [legacyMember]);
  assert.deepEqual(
    request({
      ...legacyMember,
      responsibility:
        "Own the release decision and preserve unresolved evidence conflicts.",
    }).members,
    [
      {
        ...legacyMember,
        responsibility:
          "Own the release decision and preserve unresolved evidence conflicts.",
      },
    ],
  );
  assert.equal(
    request({ ...legacyMember, responsibility: "🚀".repeat(240) }).members[0]
      ?.responsibility,
    "🚀".repeat(240),
  );
  assert.throws(
    () => request({ ...legacyMember, responsibility: "" }),
    /office_member_invalid/u,
  );
  assert.throws(
    () => request({ ...legacyMember, responsibility: " padded " }),
    /office_member_invalid/u,
  );
  assert.throws(
    () => request({ ...legacyMember, responsibility: 42 }),
    /office_member_invalid/u,
  );
  assert.throws(
    () => request({ ...legacyMember, responsibility: "x".repeat(241) }),
    /office_member_invalid/u,
  );
  assert.throws(
    () => request({ ...legacyMember, responsibility: "🚀".repeat(241) }),
    /office_member_invalid/u,
  );
  assert.throws(
    () => request({ ...legacyMember, responsibility: "e\u0301vidence" }),
    /office_member_invalid/u,
  );
  assert.throws(
    () => request({ ...legacyMember, unexpected: "injected" }),
    /unknown_field/u,
  );
});

test("parses only the immutable Office target and destination thread", () => {
  assert.deepEqual(
    parseStartOfficeRunRequest({
      targetId: "target-1",
      threadId: "thread-1",
    }),
    { targetId: "target-1", threadId: "thread-1" },
  );
  assert.throws(
    () =>
      parseStartOfficeRunRequest({
        targetId: "target-1",
        threadId: "thread-1",
        agentVersionId: "client-owned-version",
      }),
    /unknown_field/u,
  );
});
