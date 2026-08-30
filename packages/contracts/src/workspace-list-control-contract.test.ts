import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ContractValidationError } from "./contract-validation-error.ts";
import {
  isWorkspaceOperationTerminal,
  parseCreateWorkspaceListRequest,
  parseGetWorkspaceOperationResponse,
  parseListWorkspaceOperationsResponse,
  parseWorkspaceExecutionId,
  parseWorkspaceOperationActionRequest,
  parseWorkspaceOperationEventView,
  parseWorkspaceOperationLastEventSequence,
  parseWorkspaceOperationListQuery,
  parseWorkspaceOperationMutationResponse,
  parseWorkspaceOperationView,
  type WorkspaceOperationView,
} from "./workspace-list-control-contract.ts";

const openApi = JSON.parse(
  readFileSync(
    new URL("../openapi/control-api.v1.json", import.meta.url),
    "utf8",
  ),
) as {
  paths: Record<
    string,
    Record<
      string,
      {
        parameters?: readonly Readonly<{ $ref: string }>[];
        description?: string;
      }
    >
  >;
  components: {
    schemas: Record<string, unknown>;
  };
};

const pendingOperation = Object.freeze({
  threadId: "thread-1",
  executionId: "exec-1",
  revision: 1,
  status: "pending",
  result: null,
});

const completedOperation = Object.freeze({
  threadId: "thread-1",
  executionId: "exec-1",
  revision: 2,
  status: "completed",
  result: {
    status: "completed",
    entries: [
      { name: "a.txt", kind: "file" },
      { name: "folder", kind: "directory" },
    ],
    truncated: false,
  },
});

test("freezes the public Workspace paths, required mutation headers, and redacted schemas", () => {
  const collection =
    openApi.paths["/api/v1/threads/{threadId}/workspace-list"]!;
  assert.deepEqual(
    collection.post!.parameters!.map((parameter) => parameter.$ref),
    [
      "#/components/parameters/ThreadId",
      "#/components/parameters/IdempotencyKey",
      "#/components/parameters/RequiredCsrfToken",
    ],
  );
  assert.deepEqual(
    collection.get!.parameters!.map((parameter) => parameter.$ref),
    [
      "#/components/parameters/ThreadId",
      "#/components/parameters/WorkspaceAfterExecutionId",
      "#/components/parameters/WorkspaceOperationLimit",
    ],
  );

  for (const phase of ["reconcile", "cancel"] as const) {
    const operation =
      openApi.paths[
        `/api/v1/threads/{threadId}/workspace-list/{executionId}:${phase}`
      ]!.post!;
    assert.deepEqual(
      operation.parameters!.map((parameter) => parameter.$ref),
      [
        "#/components/parameters/ThreadId",
        "#/components/parameters/WorkspaceExecutionId",
        "#/components/parameters/IdempotencyKey",
        "#/components/parameters/RequiredCsrfToken",
      ],
    );
  }

  const eventStream =
    openApi.paths[
      "/api/v1/threads/{threadId}/workspace-list/{executionId}/events"
    ]!.get!;
  assert.match(eventStream.description!, /may close.*terminal/u);
  assert.match(eventStream.description!, /Last-Event-ID/u);

  const publicSchemaNames = [
    "WorkspaceOperationView",
    "WorkspaceCompletedResultView",
    "WorkspaceFailedResultView",
    "WorkspaceOperationMutationResponse",
    "GetWorkspaceOperationResponse",
    "ListWorkspaceOperationsResponse",
    "WorkspaceOperationEventView",
  ];
  const propertyNames = new Set<string>();
  for (const schemaName of publicSchemaNames) {
    collectPropertyNames(openApi.components.schemas[schemaName], propertyNames);
  }
  for (const privateField of [
    "tenantId",
    "spaceId",
    "principalId",
    "actorId",
    "actionDigest",
    "commandDigest",
    "providerReceiptId",
    "deviceId",
    "deviceBindingId",
    "workspaceBindingId",
    "incarnationId",
    "runtimeBindingId",
    "policySnapshotId",
    "lease",
    "path",
    "agentVersionId",
  ]) {
    assert.equal(propertyNames.has(privateField), false, privateField);
  }
});

test("parses exact create and action request bodies with hard revision and entry bounds", () => {
  assert.deepEqual(
    parseCreateWorkspaceListRequest({
      expectedThreadRevision: 7,
      maxEntries: 200,
    }),
    { expectedThreadRevision: 7, maxEntries: 200 },
  );
  assert.deepEqual(
    parseWorkspaceOperationActionRequest({ expectedOperationRevision: 3 }),
    { expectedOperationRevision: 3 },
  );
  for (const input of [
    { expectedThreadRevision: 7, maxEntries: 201 },
    { expectedThreadRevision: 0, maxEntries: 1 },
    { expectedThreadRevision: 7, maxEntries: 1, agentVersionId: "forged" },
    { expectedThreadRevision: 7 },
  ]) {
    assert.throws(
      () => parseCreateWorkspaceListRequest(input),
      ContractValidationError,
    );
  }
  assert.throws(
    () =>
      parseWorkspaceOperationActionRequest({
        expectedOperationRevision: 3,
        executionId: "forged",
      }),
    ContractValidationError,
  );
});

test("parses nullable lexicographic list cursors and rejects malformed query fields", () => {
  assert.deepEqual(parseWorkspaceOperationListQuery({}), {
    afterExecutionId: null,
    limit: 100,
  });
  assert.deepEqual(
    parseWorkspaceOperationListQuery({
      afterExecutionId: null,
      limit: "25",
    }),
    { afterExecutionId: null, limit: 25 },
  );
  assert.deepEqual(
    parseWorkspaceOperationListQuery({
      afterExecutionId: "exec-009",
      limit: 1,
    }),
    { afterExecutionId: "exec-009", limit: 1 },
  );
  for (const input of [
    { afterExecutionId: "" },
    { afterExecutionId: "exec/1" },
    { limit: 0 },
    { limit: 101 },
    { limit: "01" },
    { cursor: "opaque" },
  ]) {
    assert.throws(
      () => parseWorkspaceOperationListQuery(input),
      ContractValidationError,
    );
  }
});

test("deep-validates redacted operation variants and raw UTF-8 entry order", () => {
  assert.deepEqual(
    parseWorkspaceOperationView(pendingOperation),
    pendingOperation,
  );
  assert.deepEqual(
    parseWorkspaceOperationView(completedOperation, {
      threadId: "thread-1",
      executionId: "exec-1",
    }),
    completedOperation,
  );
  assert.deepEqual(
    parseWorkspaceOperationView({
      threadId: "thread-1",
      executionId: "exec-2",
      revision: 2,
      status: "completed",
      result: {
        status: "completed",
        entries: [
          { name: "z", kind: "file" },
          { name: "é", kind: "directory" },
        ],
        truncated: true,
      },
    }),
    {
      threadId: "thread-1",
      executionId: "exec-2",
      revision: 2,
      status: "completed",
      result: {
        status: "completed",
        entries: [
          { name: "z", kind: "file" },
          { name: "é", kind: "directory" },
        ],
        truncated: true,
      },
    },
  );
  assert.deepEqual(
    parseWorkspaceOperationView({
      threadId: "thread-1",
      executionId: "exec-3",
      revision: 4,
      status: "failed",
      result: { status: "failed", code: "device.unavailable", retryable: true },
    }),
    {
      threadId: "thread-1",
      executionId: "exec-3",
      revision: 4,
      status: "failed",
      result: { status: "failed", code: "device.unavailable", retryable: true },
    },
  );

  const invalid = [
    { ...pendingOperation, tenantId: "secret" },
    {
      ...pendingOperation,
      result: { status: "completed", entries: [], truncated: false },
    },
    { ...completedOperation, status: "failed" },
    {
      ...completedOperation,
      result: { ...completedOperation.result, providerReceiptId: "secret" },
    },
    {
      ...completedOperation,
      result: {
        ...completedOperation.result,
        entries: [
          { name: "é", kind: "file" },
          { name: "z", kind: "file" },
        ],
      },
    },
    {
      ...completedOperation,
      result: {
        ...completedOperation.result,
        entries: [{ name: "😀".repeat(64), kind: "file" }],
      },
    },
    {
      threadId: "thread-1",
      executionId: "exec-3",
      revision: 4,
      status: "failed",
      result: { status: "failed", code: "Unsafe Message", retryable: false },
    },
  ];
  for (const input of invalid) {
    assert.throws(
      () => parseWorkspaceOperationView(input),
      ContractValidationError,
    );
  }
  assert.doesNotThrow(() =>
    parseWorkspaceOperationView({
      ...completedOperation,
      result: {
        ...completedOperation.result,
        entries: [{ name: "😀".repeat(63), kind: "file" }],
      },
    }),
  );
});

test("binds mutation and atomic snapshot cursors to the exact operation identity and revision", () => {
  assert.deepEqual(
    parseWorkspaceOperationMutationResponse(
      {
        disposition: "committed",
        eventSequence: 2,
        operation: completedOperation,
      },
      { threadId: "thread-1", executionId: "exec-1" },
    ),
    {
      disposition: "committed",
      eventSequence: 2,
      operation: completedOperation,
    },
  );
  assert.deepEqual(
    parseGetWorkspaceOperationResponse(
      { operation: completedOperation, eventSequence: 2 },
      { threadId: "thread-1", executionId: "exec-1" },
    ),
    { operation: completedOperation, eventSequence: 2 },
  );
  for (const mutation of [
    {
      disposition: "committed",
      eventSequence: 1,
      operation: completedOperation,
    },
    { disposition: "fresh", eventSequence: 2, operation: completedOperation },
    {
      disposition: "committed",
      eventSequence: 2,
      operation: { ...completedOperation, threadId: "thread-2" },
    },
  ]) {
    assert.throws(
      () =>
        parseWorkspaceOperationMutationResponse(mutation, {
          threadId: "thread-1",
          executionId: "exec-1",
        }),
      ContractValidationError,
    );
  }
  assert.throws(
    () =>
      parseGetWorkspaceOperationResponse(
        { operation: completedOperation, eventSequence: 2 },
        { threadId: "thread-1", executionId: "exec-other" },
      ),
    ContractValidationError,
  );
});

test("validates stable bounded recovery pages before exposing operations", () => {
  const query = parseWorkspaceOperationListQuery({ limit: 100 });
  const data = Array.from({ length: 100 }, (_, index) => ({
    ...pendingOperation,
    executionId: `exec-${String(index).padStart(3, "0")}`,
  }));
  assert.deepEqual(
    parseListWorkspaceOperationsResponse(
      { data, nextAfterExecutionId: "exec-099" },
      { threadId: "thread-1", query },
    ),
    { data, nextAfterExecutionId: "exec-099" },
  );
  assert.throws(
    () =>
      parseListWorkspaceOperationsResponse(
        {
          data: [...data, { ...pendingOperation, executionId: "exec-100" }],
          nextAfterExecutionId: "exec-100",
        },
        { threadId: "thread-1", query },
      ),
    ContractValidationError,
  );
  for (const response of [
    {
      data: [
        { ...pendingOperation, executionId: "exec-002" },
        { ...pendingOperation, executionId: "exec-001" },
      ],
      nextAfterExecutionId: null,
    },
    {
      data: [{ ...pendingOperation, executionId: "exec-001" }],
      nextAfterExecutionId: "exec-other",
    },
    {
      data: [{ ...pendingOperation, threadId: "thread-2" }],
      nextAfterExecutionId: null,
    },
  ]) {
    assert.throws(
      () =>
        parseListWorkspaceOperationsResponse(response, {
          threadId: "thread-1",
          query: { afterExecutionId: null, limit: 2 },
        }),
      ContractValidationError,
    );
  }

  const oversized = Array.from({ length: 40 }, (_, operationIndex) => ({
    ...completedOperation,
    executionId: `large-${String(operationIndex).padStart(3, "0")}`,
    result: {
      ...completedOperation.result,
      entries: Array.from({ length: 200 }, (_, entryIndex) => ({
        name: `${String(entryIndex).padStart(3, "0")}-${"x".repeat(245)}`,
        kind: "file",
      })),
    },
  }));
  assert.throws(
    () =>
      parseListWorkspaceOperationsResponse(
        { data: oversized, nextAfterExecutionId: null },
        { threadId: "thread-1", query },
      ),
    /workspace_list_response_too_large/u,
  );
});

function collectPropertyNames(input: unknown, output: Set<string>) {
  if (Array.isArray(input)) {
    for (const value of input) collectPropertyNames(value, output);
    return;
  }
  if (typeof input !== "object" || input === null) return;
  for (const [key, value] of Object.entries(input)) {
    if (key === "properties" && typeof value === "object" && value !== null) {
      for (const propertyName of Object.keys(value)) output.add(propertyName);
    }
    collectPropertyNames(value, output);
  }
}
