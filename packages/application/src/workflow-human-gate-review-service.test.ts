import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkflowHumanGateReviewApplicationService,
  validateWorkflowHumanGateReviewComment,
} from "./workflow-human-gate-review-service.ts";
import { RunStoreError } from "./run-store-port.ts";
const actor = {
  tenantId: "tenant",
  spaceId: "space",
  actorId: "actor",
  principalId: "principal",
};
const locator = { runId: "run", nodeId: "gate", gateRequestId: "request" };
const command = {
  ...locator,
  kind: "workflowHumanGate.review" as const,
  inputDigest: `sha256:${"a".repeat(64)}`,
  decision: "approved" as const,
  comment: "  审批\n保留原文  ",
};

test("review comments preserve exact empty/null/multiline text with a well-formed UTF8 4096-byte bound", () => {
  for (const value of [
    null,
    "",
    command.comment,
    "a".repeat(4096),
    "😀".repeat(1024),
  ])
    assert.doesNotThrow(() => validateWorkflowHumanGateReviewComment(value));
  for (const value of [
    undefined,
    {},
    0,
    "a".repeat(4097),
    "😀".repeat(1025),
    "\ud800",
    "\udc00",
    "\u0000",
  ])
    assert.throws(() => validateWorkflowHumanGateReviewComment(value), {
      code: "workflow_gate_comment_invalid",
    });
});
test("review requests reject getters and extra fields before Store access", async () => {
  let calls = 0,
    getters = 0;
  const service = new WorkflowHumanGateReviewApplicationService({
    async loadWorkflowHumanGateReview() {
      calls++;
      throw Error("unused");
    },
    async reviewWorkflowHumanGate() {
      calls++;
      throw Error("unused");
    },
  });
  const getter = { ...command };
  Object.defineProperty(getter, "comment", {
    enumerable: true,
    get() {
      getters++;
      return "x";
    },
  });
  for (const value of [
    getter,
    { ...command, comment: "\ud800" },
    { ...command, output: {} },
    { ...command, decision: "yes" },
    { ...command, inputDigest: "bad" },
    { ...command, comment: undefined },
    { ...command, [Symbol("hidden")]: "x" },
  ])
    await assert.rejects(service.reviewGate(actor, value as any), {
      category: "validation",
    });
  const actorGetter = { ...actor };
  Object.defineProperty(actorGetter, "principalId", {
    enumerable: true,
    get() {
      getters++;
      return "principal";
    },
  });
  await assert.rejects(service.getReview(actorGetter, locator), {
    category: "validation",
  });
  assert.equal(calls, 0);
  assert.equal(getters, 0);
});
test("review service captures scalar fields before awaiting and maps legacy unknown review to conflict", async () => {
  const value = { ...command },
    principal = { ...actor };
  const service = new WorkflowHumanGateReviewApplicationService({
    async loadWorkflowHumanGateReview() {
      throw new RunStoreError("workflow_gate_review_not_recorded_conflict");
    },
    async reviewWorkflowHumanGate(input) {
      await Promise.resolve();
      assert.equal(input.command.comment, command.comment);
      assert.equal(input.actor.principalId, actor.principalId);
      throw new RunStoreError("workflow_gate_review_comment_conflict");
    },
  });
  const pending = service.reviewGate(principal, value);
  value.comment = "changed";
  principal.principalId = "changed";
  await assert.rejects(pending, {
    category: "conflict",
    code: "workflow_gate_review_comment_conflict",
  });
  await assert.rejects(service.getReview(actor, locator), {
    category: "conflict",
    code: "workflow_gate_review_not_recorded_conflict",
  });
});
