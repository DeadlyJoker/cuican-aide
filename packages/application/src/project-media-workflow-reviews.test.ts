import assert from "node:assert/strict";
import test from "node:test";
import { captureProjectMediaWorkflowReviews } from "./project-media-input-application-service.ts";
import type { ProjectMediaWorkflowReview } from "./project-media-input-port.ts";
import { namedMediaWorkflowReviewHistory } from "./project-media-workflow-reviews.test-support.ts";

const capture = (input: unknown) =>
  captureProjectMediaWorkflowReviews(
    input as readonly ProjectMediaWorkflowReview[],
  );

test("both reviews of every pinned package survive 17 upgrades and the 32-package Native budget", () => {
  for (const packages of [17, 32]) {
    const original = namedMediaWorkflowReviewHistory(packages);
    const result = capture(original);
    assert.equal(result.length, packages * 2);
    assert.deepEqual(result, original);
    assert.notEqual(result, original);
    for (const [index, review] of result.entries()) {
      assert.notEqual(review, original[index]);
      assert.ok(Object.isFrozen(review));
      assert.ok(Object.isFrozen(review.targetIdentity));
      assert.ok(Object.isFrozen(review.workflow.output));
    }
    assert.ok(Object.isFrozen(result));
  }
});

test("empty and 65-review inputs still fail closed", () => {
  for (const reviews of [[], namedMediaWorkflowReviewHistory(33).slice(0, 65)])
    assert.throws(
      () => capture(reviews),
      /^Error: project_media_input_review_invalid$/u,
    );
});

test("identical or conflicting workflows for the same complete target pin remain ambiguous and rejected", () => {
  const reviews = namedMediaWorkflowReviewHistory(17);
  const first = reviews[0]!;
  for (const duplicate of [
    first,
    {
      ...first,
      workflow: {
        ...first.workflow,
        workflowDigest: `sha256:${"f".repeat(64)}`,
      },
    },
  ])
    assert.throws(
      () => capture([...reviews, duplicate]),
      /^Error: project_media_input_review_invalid$/u,
    );
});

test("expanded history does not accept malformed identity, workflow output or unknown fields", () => {
  const reviews = namedMediaWorkflowReviewHistory(32);
  const first = reviews[0]!;
  for (const invalid of [
    { ...first, extra: "unreviewed" },
    { ...first, targetIdentity: { ...first.targetIdentity, version: "v1" } },
    {
      ...first,
      targetIdentity: { ...first.targetIdentity, packageDigest: "unverified" },
    },
    {
      ...first,
      workflow: {
        ...first.workflow,
        output: { ...first.workflow.output, nodeId: "17" },
      },
    },
  ])
    assert.throws(() => capture([invalid, ...reviews.slice(1)]));
});

test("bounded descriptor capture still rejects accessors, proxies, cycles, excessive bytes, depth and nodes without invoking hooks", () => {
  const reviews = namedMediaWorkflowReviewHistory(17);
  let getters = 0;
  const accessor = Object.defineProperty({ ...reviews[0] }, "targetIdentity", {
    enumerable: true,
    get() {
      getters++;
      return reviews[0]!.targetIdentity;
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let deep: unknown = null;
  for (let index = 0; index < 33; index++) deep = { next: deep };
  for (const invalid of [
    [accessor, ...reviews.slice(1)],
    new Proxy(reviews, {}),
    [cycle],
    [{ ...reviews[0], extra: "x".repeat(192 * 1024 + 1) }],
    [deep],
    [Array.from({ length: 8192 }, () => [null, null, null])],
  ])
    assert.throws(
      () => capture(invalid),
      /^Error: project_media_input_data_invalid$/u,
    );
  assert.equal(getters, 0);
});
