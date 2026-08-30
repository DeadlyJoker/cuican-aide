import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlApiClient,
  ControlApiProtocolError,
} from "./control-api-client.ts";

test("uses typed Workspace routes, explicit mutation authority, and encoded pagination", async () => {
  const requests: { input: string; init: RequestInit }[] = [];
  const responses = [
    mutation(pendingOperation("workspace:exec-1", 1), "committed"),
    {
      data: [
        completedOperation("workspace:exec-2", 2),
        unknownOperation("workspace:exec-3", 2),
      ],
      nextAfterExecutionId: "workspace:exec-3",
    },
    snapshot(pendingOperation("workspace:exec-1", 1)),
    mutation(completedOperation("workspace:exec-1", 2), "replayed"),
    mutation(unknownOperation("workspace:exec-1", 3), "committed"),
  ];
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    accessToken: "workspace-token",
    csrfToken: "workspace-csrf",
    origin: "https://app.example",
    fetch: async (input, init = {}) => {
      requests.push({ input: String(input), init });
      const body = responses.shift();
      assert.notEqual(body, undefined);
      return jsonResponse(requests.length === 1 ? 201 : 200, body);
    },
  });

  assert.deepEqual(
    await client.createWorkspaceListOperation(
      "thread/1",
      { expectedThreadRevision: 7, maxEntries: 100 },
      "workspace-create-1",
    ),
    mutation(pendingOperation("workspace:exec-1", 1), "committed"),
  );
  assert.deepEqual(
    await client.listWorkspaceListOperations("thread/1", {
      afterExecutionId: "workspace:exec-1",
      limit: 100,
    }),
    {
      data: [
        completedOperation("workspace:exec-2", 2),
        unknownOperation("workspace:exec-3", 2),
      ],
      nextAfterExecutionId: "workspace:exec-3",
    },
  );
  assert.deepEqual(
    await client.getWorkspaceListOperation("thread/1", "workspace:exec-1"),
    snapshot(pendingOperation("workspace:exec-1", 1)),
  );
  assert.deepEqual(
    await client.reconcileWorkspaceListOperation(
      "thread/1",
      "workspace:exec-1",
      { expectedOperationRevision: 1 },
      "workspace-reconcile-1",
    ),
    mutation(completedOperation("workspace:exec-1", 2), "replayed"),
  );
  assert.deepEqual(
    await client.cancelWorkspaceListOperation(
      "thread/1",
      "workspace:exec-1",
      { expectedOperationRevision: 2 },
      "workspace-cancel-1",
    ),
    mutation(unknownOperation("workspace:exec-1", 3), "committed"),
  );

  assert.deepEqual(
    requests.map(({ input, init }) => ({
      input,
      method: init.method,
      csrf: new Headers(init.headers).get("x-csrf-token"),
      key: new Headers(init.headers).get("idempotency-key"),
      body: init.body === undefined ? null : JSON.parse(String(init.body)),
    })),
    [
      {
        input:
          "https://control.example/api/v1/threads/thread%2F1/workspace-list",
        method: "POST",
        csrf: "workspace-csrf",
        key: "workspace-create-1",
        body: { expectedThreadRevision: 7, maxEntries: 100 },
      },
      {
        input:
          "https://control.example/api/v1/threads/thread%2F1/workspace-list?afterExecutionId=workspace%3Aexec-1&limit=100",
        method: "GET",
        csrf: null,
        key: null,
        body: null,
      },
      {
        input:
          "https://control.example/api/v1/threads/thread%2F1/workspace-list/workspace%3Aexec-1",
        method: "GET",
        csrf: null,
        key: null,
        body: null,
      },
      {
        input:
          "https://control.example/api/v1/threads/thread%2F1/workspace-list/workspace%3Aexec-1:reconcile",
        method: "POST",
        csrf: "workspace-csrf",
        key: "workspace-reconcile-1",
        body: { expectedOperationRevision: 1 },
      },
      {
        input:
          "https://control.example/api/v1/threads/thread%2F1/workspace-list/workspace%3Aexec-1:cancel",
        method: "POST",
        csrf: "workspace-csrf",
        key: "workspace-cancel-1",
        body: { expectedOperationRevision: 2 },
      },
    ],
  );
});

test("fails before fetch without explicit Workspace CSRF, key, or bounded inputs", async () => {
  let calls = 0;
  const noCsrf = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () => {
      calls += 1;
      return jsonResponse(500, {});
    },
  });
  await assert.rejects(
    noCsrf.createWorkspaceListOperation(
      "thread-1",
      { expectedThreadRevision: 1, maxEntries: 1 },
      "create-1",
    ),
    hasProtocolCode("control_client_csrf_token_required"),
  );

  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    csrfToken: "csrf",
    fetch: async () => {
      calls += 1;
      return jsonResponse(500, {});
    },
  });
  await assert.rejects(
    client.createWorkspaceListOperation(
      "thread-1",
      { expectedThreadRevision: 1, maxEntries: 1 },
      undefined as never,
    ),
    hasProtocolCode("control_client_idempotency_key_required"),
  );
  await assert.rejects(
    client.listWorkspaceListOperations("thread-1", { limit: 101 }),
  );
  assert.equal(calls, 0);
});

test("accepts UTF-8 results and fails closed for cross-scope or malformed projections", async () => {
  const valid = completedOperation("workspace:exec-1", 2);
  const responses = [
    snapshot(valid),
    snapshot({ ...valid, threadId: "thread-2" }),
    snapshot({
      ...valid,
      extra: "private-authority",
    } as unknown as typeof valid),
  ];
  const client = new ControlApiClient({
    baseUrl: "https://control.example/",
    fetch: async () => jsonResponse(200, responses.shift()),
  });

  assert.deepEqual(
    await client.getWorkspaceListOperation("thread/1", "workspace:exec-1"),
    snapshot(valid),
  );
  await assert.rejects(
    client.getWorkspaceListOperation("thread/1", "workspace:exec-1"),
  );
  await assert.rejects(
    client.getWorkspaceListOperation("thread/1", "workspace:exec-1"),
  );
});

function pendingOperation(executionId: string, revision: number) {
  return {
    threadId: "thread/1",
    executionId,
    revision,
    status: "pending" as const,
    result: null,
  };
}

function unknownOperation(executionId: string, revision: number) {
  return {
    threadId: "thread/1",
    executionId,
    revision,
    status: "unknownOutcome" as const,
    result: null,
  };
}

function completedOperation(executionId: string, revision: number) {
  return {
    threadId: "thread/1",
    executionId,
    revision,
    status: "completed" as const,
    result: {
      status: "completed" as const,
      entries: [
        { name: "README.md", kind: "file" as const },
        { name: "中文", kind: "directory" as const },
      ],
      truncated: false,
    },
  };
}

function mutation(
  operation: ReturnType<
    | typeof pendingOperation
    | typeof unknownOperation
    | typeof completedOperation
  >,
  disposition: "committed" | "replayed",
) {
  return { disposition, eventSequence: operation.revision, operation };
}

function snapshot(
  operation: ReturnType<
    | typeof pendingOperation
    | typeof unknownOperation
    | typeof completedOperation
  >,
) {
  return { operation, eventSequence: operation.revision };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function hasProtocolCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ControlApiProtocolError && error.code === code;
}
