import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowVersionCatalogResponse } from "./workflow-catalog-contract.ts";
import {
  parseWorkflowVersionCatalogQuery,
  formatWorkflowVersionCursor,
} from "./control-api-contract.ts";
const summary = {
  workflowId: "workflow",
  workflowVersionId: "v-1",
  name: "名称",
  description: "描述",
  contentDigest: `sha256:${"a".repeat(64)}`,
  createdAt: "2026-10-17T00:00:00.000Z",
};
test("catalog uses bounded composite cursors and rejects mismatched page ends, duplicate versions and unknown authority", () => {
  const cursor = formatWorkflowVersionCursor(
    summary.workflowId,
    summary.workflowVersionId,
  );
  assert.deepEqual(parseWorkflowVersionCatalogQuery({ cursor, limit: "1" }), {
    after: {
      workflowId: summary.workflowId,
      workflowVersionId: summary.workflowVersionId,
    },
    limit: 1,
  });
  assert.deepEqual(
    parseWorkflowVersionCatalogResponse(
      { data: [summary], nextCursor: cursor },
      { limit: 1, after: null },
    ),
    { data: [summary], nextCursor: cursor },
  );
  assert.throws(() =>
    parseWorkflowVersionCatalogResponse(
      { data: [summary], nextCursor: null },
      {
        limit: 20,
        after: {
          workflowId: summary.workflowId,
          workflowVersionId: summary.workflowVersionId,
        },
      },
    ),
  );
  for (const value of [
    { limit: 21 },
    { limit: 0 },
    { cursor: "wrong" },
    { workflowId: "ignored" },
  ])
    assert.throws(() => parseWorkflowVersionCatalogQuery(value));
  for (const value of [
    { data: [summary, summary], nextCursor: null },
    {
      data: [summary, { ...summary, workflowId: "z-workflow" }],
      nextCursor: null,
    },
    { data: [summary], nextCursor: "wrong" },
    { data: [{ ...summary, tenantId: "secret" }], nextCursor: null },
    { data: [{ ...summary, name: "\ud800" }], nextCursor: null },
    { data: [], nextCursor: cursor },
  ])
    assert.throws(() =>
      parseWorkflowVersionCatalogResponse(value, { limit: 20, after: null }),
    );
});
test("catalog response capture refuses hooks, oversize values and unbounded counts without running getters", () => {
  let calls = 0;
  const value = { data: [summary], nextCursor: null };
  Object.defineProperty(value, "data", {
    enumerable: true,
    get() {
      calls++;
      return [];
    },
  });
  assert.throws(() =>
    parseWorkflowVersionCatalogResponse(value, { limit: 20, after: null }),
  );
  assert.throws(() =>
    parseWorkflowVersionCatalogResponse(
      {
        data: [{ ...summary, description: "x".repeat(1024 * 1024 + 1) }],
        nextCursor: null,
      },
      { limit: 20, after: null },
    ),
  );
  assert.equal(calls, 0);
});
