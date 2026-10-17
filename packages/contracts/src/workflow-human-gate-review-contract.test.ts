import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWorkflowReviewCapability,
  parseReviewWorkflowHumanGateRequest,
  parseWorkflowHumanGateReviewResponse,
  parseWorkflowHumanGateReviewMutationResponse,
  parseWorkflowHumanGateReviewComment,
} from "./workflow-human-gate-review-contract.ts";
import { workflowGateReviewFixture } from "./workflow-human-gate-review.test-support.ts";
import {
  workflowReadLocator,
  workflowReadDigest,
} from "./workflow-run-read.test-support.ts";
test("review contracts bind old gate authority, status and input limits while preserving exact new review text", () => {
  for (const comment of [
    null,
    "",
    "  审批\n意见  ",
    "\ufeff😀",
    "\u0001".repeat(4096),
  ]) {
    const view = workflowGateReviewFixture(comment),
      body = {
        inputDigest: workflowReadDigest,
        decision: "approved" as const,
        comment,
      };
    assert.deepEqual(
      parseWorkflowHumanGateReviewResponse(view, workflowReadLocator),
      view,
    );
    const response = {
      disposition: "committed" as const,
      review: view.review!,
    };
    assert.deepEqual(
      parseWorkflowHumanGateReviewMutationResponse(
        response,
        workflowReadLocator,
        body,
      ),
      response,
    );
    assert.deepEqual(parseReviewWorkflowHumanGateRequest(body), body);
  }
  const pending = {
    ...workflowGateReviewFixture(),
    status: "waitingHuman",
    review: null,
  };
  assert.deepEqual(
    parseWorkflowHumanGateReviewResponse(pending, workflowReadLocator),
    pending,
  );
  assert.deepEqual(
    parseWorkflowReviewCapability({ version: "v1", available: false }),
    { version: "v1", available: false },
  );
});
test("review contracts reject changed command, identity, malformed text, legacy shapes and foreign status", () => {
  const view = workflowGateReviewFixture(),
    response = { disposition: "committed", review: view.review };
  for (const value of [
    undefined,
    1,
    {},
    "\ud800",
    "\udc00",
    "\u0000",
    "😀".repeat(1025),
    "x".repeat(4097),
  ])
    assert.throws(() => parseWorkflowHumanGateReviewComment(value));
  for (const value of [
    { ...view, status: "waitingHuman" },
    { ...view, schemaVersion: "crewon.workflow-human-gate.v0" },
    { ...view, decision: view.review!.decision },
    { ...view, review: { ...view.review, comment: "\ud800" } },
    {
      ...view,
      review: {
        ...view.review,
        decision: { ...view.review!.decision, outcome: "rejected" },
      },
    },
    { ...view, authority: { ...view.authority, nodeId: "foreign" } },
  ])
    assert.throws(() =>
      parseWorkflowHumanGateReviewResponse(value, workflowReadLocator),
    );
  for (const body of [
    { inputDigest: workflowReadDigest, decision: "approved", comment: null },
    {
      inputDigest: workflowReadDigest,
      decision: "rejected",
      comment: view.review!.comment,
    },
    {
      inputDigest: `sha256:${"b".repeat(64)}`,
      decision: "approved",
      comment: view.review!.comment,
    },
  ])
    assert.throws(() =>
      parseWorkflowHumanGateReviewMutationResponse(
        response,
        workflowReadLocator,
        body as any,
      ),
    );
  for (const value of [
    { version: "v2", available: true },
    { version: "v1", available: true, admission: true },
    { version: "v1" },
  ])
    assert.throws(() => parseWorkflowReviewCapability(value));
});
test("review JSON capture never invokes getters/toJSON and refuses sparse, oversized or cyclic data", () => {
  let called = 0;
  const getter = workflowGateReviewFixture();
  Object.defineProperty(getter.review!, "comment", {
    enumerable: true,
    get() {
      called++;
      return "comment";
    },
  });
  assert.throws(() =>
    parseWorkflowHumanGateReviewResponse(getter, workflowReadLocator),
  );
  const hook = {
    ...workflowGateReviewFixture(),
    toJSON() {
      called++;
      return {};
    },
  };
  assert.throws(() =>
    parseWorkflowHumanGateReviewResponse(hook, workflowReadLocator),
  );
  for (const input of [[, "sparse"], { x: "a".repeat(131073) }])
    assert.throws(() =>
      parseWorkflowHumanGateReviewResponse(
        { ...workflowGateReviewFixture(), input },
        workflowReadLocator,
      ),
    );
  const cyclic: any = workflowGateReviewFixture();
  cyclic.input = cyclic;
  assert.throws(() =>
    parseWorkflowHumanGateReviewResponse(cyclic, workflowReadLocator),
  );
  assert.equal(called, 0);
});
