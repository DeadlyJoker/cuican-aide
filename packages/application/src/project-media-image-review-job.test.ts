import assert from "node:assert/strict";
import test from "node:test";
import {
  createProjectMediaImageReviewJob,
  parseProjectMediaImageReviewJob,
  sameProjectMediaImageReviewJobIntent,
} from "./project-media-image-review-job.ts";
const original = {
  request: {
    actor: {
      tenantId: "tenant",
      spaceId: "space",
      principalId: "owner",
      actorId: "actor",
    },
    query: { projectId: "project", runId: "generation", resultIndex: 0 },
  },
  candidateId: "candidate",
  candidateDigest: `sha256:${"a".repeat(64)}`,
  originalByteDigest: `sha256:${"b".repeat(64)}`,
  runId: "review",
  threadId: "thread",
  agentVersionId: "reviewer",
  authorityId: "host",
  runtimeGeneration: "host-generation",
  policySnapshotId: "policy",
  createdAt: "2026-10-15T16:00:00.000Z",
};
test("immutable job pins original actor, candidate and host route; canonical clone only carries data", () => {
  const job = createProjectMediaImageReviewJob(original);
  assert.deepEqual(
    parseProjectMediaImageReviewJob(JSON.parse(JSON.stringify(job))),
    job,
  );
  assert.equal(Object.isFrozen(job), true);
  assert.equal(
    sameProjectMediaImageReviewJobIntent(
      job,
      createProjectMediaImageReviewJob({
        ...original,
        runId: "retry",
        createdAt: "2026-10-15T16:01:00.000Z",
      }),
    ),
    true,
  );
  for (const input of [
    { ...original, candidateId: "other" },
    { ...original, policySnapshotId: "other" },
    {
      ...original,
      request: {
        ...original.request,
        actor: { ...original.request.actor, actorId: "other" },
      },
    },
  ])
    assert.equal(
      sameProjectMediaImageReviewJobIntent(
        job,
        createProjectMediaImageReviewJob(input),
      ),
      false,
    );
});
test("job parser rejects altered pins, unknown fields and executable getter input", () => {
  const job = createProjectMediaImageReviewJob(original);
  assert.throws(() =>
    parseProjectMediaImageReviewJob({ ...job, candidateId: "other" }),
  );
  assert.throws(() =>
    parseProjectMediaImageReviewJob({ ...job, approved: true }),
  );
  assert.throws(() => parseProjectMediaImageReviewJob(new Proxy(job, {})));
  const malicious = Object.defineProperty({ ...job }, "request", {
    get() {
      throw new Error("getter executed");
    },
  });
  assert.throws(
    () => parseProjectMediaImageReviewJob(malicious),
    (error: unknown) =>
      error instanceof Error && error.message !== "getter executed",
  );
  const createInput = Object.defineProperty({ ...original }, "request", {
    get() {
      throw new Error("factory getter executed");
    },
  });
  assert.throws(
    () => createProjectMediaImageReviewJob(createInput),
    (error: unknown) =>
      error instanceof Error && error.message !== "factory getter executed",
  );
});
