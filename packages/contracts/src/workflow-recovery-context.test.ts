import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWorkflowRecoveryContextResponse,
  parseWorkflowRecoveryContextId,
} from "./workflow-recovery-context.ts";
const contextId = `sha256:${"a".repeat(64)}`;
test("recovery context captures a bounded exact comparison token or explicit unavailable state", () => {
  for (const value of [contextId, null]) {
    const source = { version: "v1", contextId: value };
    const result = parseWorkflowRecoveryContextResponse(source);
    assert.deepEqual(result, source);
    assert.ok(Object.isFrozen(result));
    assert.notEqual(result, source);
  }
});
test("recovery context rejects ambiguous fields, accessors and invalid tokens without invoking getters", () => {
  let calls = 0;
  for (const value of [
    undefined,
    [],
    {},
    { version: "v2", contextId },
    { version: "v1", contextId, available: true },
    { version: "v1", contextId: undefined },
    { version: "v1", contextId, [Symbol()]: true },
    {
      version: "v1",
      get contextId() {
        calls++;
        return contextId;
      },
    },
  ])
    assert.throws(() => parseWorkflowRecoveryContextResponse(value));
  assert.equal(calls, 0);
  for (const value of [
    null,
    [],
    [contextId],
    contextId + "," + contextId,
    contextId + "\n",
    " " + contextId,
    contextId.toUpperCase(),
    "sha256:" + "a".repeat(65),
  ])
    assert.throws(() => parseWorkflowRecoveryContextId(value));
});
