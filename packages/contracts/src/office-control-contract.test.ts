import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatOfficeDelegationCursor,
  formatOfficeCursor,
  parseCreateOfficeRequest,
  parseOfficeDelegationListQuery,
  parseOfficeListQuery,
  parseStartOfficeDelegationRequest,
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

test("accepts only an explicit Workflow delegation request", () => {
  assert.deepEqual(
    parseStartOfficeDelegationRequest({
      workflowVersionId: "workflow-version-1",
      threadId: "thread-1",
      input: { topic: "release" },
    }),
    {
      workflowVersionId: "workflow-version-1",
      threadId: "thread-1",
      input: { topic: "release" },
    },
  );
  assert.throws(
    () =>
      parseStartOfficeDelegationRequest({
        targetId: "legacy-target",
        threadId: "thread-1",
      }),
    /workflow_run_fields_invalid/,
  );
});

test("round-trips the stable Office delegation cursor", () => {
  const before = {
    createdAt: "2026-08-14T00:00:00.000Z",
    delegationId: "delegation-1",
  };
  const cursor = formatOfficeDelegationCursor(before);
  assert.deepEqual(parseOfficeDelegationListQuery({ cursor, limit: "10" }), {
    before,
    limit: 10,
  });
  assert.throws(
    () => parseOfficeDelegationListQuery({ cursor: `${cursor}x` }),
    /office_delegation_cursor_invalid/,
  );
});
