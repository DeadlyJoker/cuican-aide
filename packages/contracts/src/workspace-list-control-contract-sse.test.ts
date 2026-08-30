import assert from "node:assert/strict";
import test from "node:test";

import { ContractValidationError } from "./contract-validation-error.ts";
import {
  isWorkspaceOperationTerminal,
  parseWorkspaceExecutionId,
  parseWorkspaceOperationEventView,
  parseWorkspaceOperationLastEventSequence,
  type WorkspaceOperationView,
} from "./workspace-list-control-contract.ts";

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

test("validates the independent Workspace SSE cursor and full replacement correlation", () => {
  const event = {
    schemaVersion: "crewon.workspace-operation-event.v0",
    threadId: "thread-1",
    executionId: "exec-1",
    sequence: 2,
    type: "workspace.operation.replaced",
    data: { operation: completedOperation },
  };
  assert.deepEqual(
    parseWorkspaceOperationEventView(event, {
      threadId: "thread-1",
      executionId: "exec-1",
      afterSequence: 1,
    }),
    event,
  );
  for (const input of [
    { ...event, sequence: 3 },
    { ...event, threadId: "thread-2" },
    { ...event, executionId: "exec-2" },
    { ...event, data: { operation: { ...completedOperation, revision: 1 } } },
    { ...event, occurredAt: "2026-08-10T00:00:00Z" },
  ]) {
    assert.throws(
      () =>
        parseWorkspaceOperationEventView(input, {
          threadId: "thread-1",
          executionId: "exec-1",
          afterSequence: 1,
        }),
      ContractValidationError,
    );
  }
  assert.equal(parseWorkspaceOperationLastEventSequence(undefined), 0);
  assert.equal(parseWorkspaceOperationLastEventSequence("2"), 2);
  for (const cursor of ["", "01", "-1", "1.5", "9007199254740992", 2]) {
    assert.throws(
      () => parseWorkspaceOperationLastEventSequence(cursor),
      ContractValidationError,
    );
  }
  assert.equal(isWorkspaceOperationTerminal(pendingOperation), false);
  assert.equal(
    isWorkspaceOperationTerminal(completedOperation as WorkspaceOperationView),
    true,
  );
  assert.equal(parseWorkspaceExecutionId("exec-1"), "exec-1");
});
