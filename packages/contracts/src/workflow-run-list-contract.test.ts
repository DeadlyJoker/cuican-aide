import assert from "node:assert/strict";
import test from "node:test";
import { workflowRunReadFixture } from "./workflow-run-read.test-support.ts";
import {
  parseWorkflowRunListQuery,
  parseWorkflowRunListResponse,
  formatWorkflowRunListCursor,
} from "./workflow-run-list-contract.ts";
const root = () => workflowRunReadFixture().run;
test("root list binds version/Thread filters, canonical time cursors, UTF8 ID order and actual page ends", () => {
  const run = root(),
    query = parseWorkflowRunListQuery({
      workflowVersionId: run.workflowVersionBinding!.workflowVersionId,
      threadId: run.threadId,
      limit: "1",
    });
  const cursor = formatWorkflowRunListCursor(query, {
    runId: run.runId,
    createdAt: run.createdAt,
  });
  assert.equal(
    parseWorkflowRunListQuery({ ...queryRequest(query), cursor }).before!
      .createdAt,
    new Date(run.createdAt).toISOString(),
  );
  assert.deepEqual(
    parseWorkflowRunListResponse({ data: [run], nextCursor: cursor }, query),
    { data: [run], nextCursor: cursor },
  );
  for (const input of [
    { ...queryRequest(query), cursor, workflowVersionId: "other" },
    { ...queryRequest(query), cursor, threadId: "other" },
    { workflowVersionId: "version-1", limit: 21 },
    { workflowVersionId: "version-1", limit: "1e1" },
    { workflowVersionId: "version-1", actorId: "forged" },
  ])
    assert.throws(() => parseWorkflowRunListQuery(input));
  const after = parseWorkflowRunListQuery({ ...queryRequest(query), cursor });
  assert.throws(() =>
    parseWorkflowRunListResponse({ data: [run], nextCursor: null }, after),
  );
  const tied = [
    { ...run, runId: "é" },
    { ...run, runId: "Z" },
  ];
  assert.equal(
    parseWorkflowRunListResponse(
      { data: tied, nextCursor: null },
      { ...query, limit: 2 },
    ).data.length,
    2,
  );
  assert.throws(() =>
    parseWorkflowRunListResponse(
      { data: [...tied].reverse(), nextCursor: null },
      { ...query, limit: 2 },
    ),
  );
  assert.equal(
    parseWorkflowRunListResponse(
      {
        data: [
          { ...run, runId: "😀" },
          { ...run, runId: "\ue000" },
        ],
        nextCursor: null,
      },
      { ...query, limit: 2 },
    ).data.length,
    2,
  );
});
test("root list rejects foreign identity, ordinary Runs, private fields, duplicates, invalid budgets and getter hooks", () => {
  const run = root(),
    query = parseWorkflowRunListQuery({ workflowVersionId: "version-1" });
  for (const value of [
    {
      data: [{ ...run, purpose: "turn", workflowVersionBinding: null }],
      nextCursor: null,
    },
    {
      data: [
        {
          ...run,
          workflowVersionBinding: {
            ...run.workflowVersionBinding!,
            workflowVersionId: "foreign",
          },
        },
      ],
      nextCursor: null,
    },
    { data: [run, run], nextCursor: null },
    { data: [{ ...run, privateState: "secret" }], nextCursor: null },
    { data: [], nextCursor: "madeup" },
    { data: [run], nextCursor: null, tenantId: "forged" },
  ])
    assert.throws(() => parseWorkflowRunListResponse(value, query));
  let hooks = 0;
  const getter = {
    workflowVersionId: "version-1",
    get cursor() {
      hooks++;
      return "x";
    },
  };
  assert.throws(() => parseWorkflowRunListQuery(getter));
  assert.throws(() =>
    parseWorkflowRunListResponse(
      {
        get data() {
          hooks++;
          return [];
        },
        nextCursor: null,
      },
      query,
    ),
  );
  assert.throws(() =>
    parseWorkflowRunListResponse(
      {
        data: [{ ...run, pad: "x".repeat(1024 * 1024 + 1) }],
        nextCursor: null,
      },
      query,
    ),
  );
  assert.equal(hooks, 0);
});
function queryRequest(q: ReturnType<typeof parseWorkflowRunListQuery>) {
  return {
    workflowVersionId: q.workflowVersionId,
    threadId: q.threadId,
    limit: q.limit,
  };
}
