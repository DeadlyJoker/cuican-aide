import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatOfficeCursor,
  parseCreateOfficeRequest,
  parseOfficeListQuery,
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
