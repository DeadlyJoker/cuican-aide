import assert from "node:assert/strict";
import test from "node:test";
import {
  assessProjectMediaImageReview,
  parseProjectMediaImageReviewReport,
  projectMediaImageReviewPrompt,
  PROJECT_MEDIA_IMAGE_REVIEW_SCHEMA,
  type ProjectMediaImageReviewSource,
} from "./project-media-image-review.ts";
const source: ProjectMediaImageReviewSource = {
  reviewRunId: "review",
  reviewerAgentVersionId: "reviewer",
  projectId: "project",
  generationRunId: "generation",
  resultIndex: 0,
  candidateId: "candidate",
  candidateDigest: `sha256:${"a".repeat(64)}`,
  originalByteDigest: `sha256:${"b".repeat(64)}`,
  image: {
    transformation: "png-to-jpeg-white-v1",
    evidenceId: "candidate-image",
    contentDigest: `sha256:${"c".repeat(64)}`,
    width: 512,
    height: 288,
  },
};
const report = () => ({
  schemaVersion: PROJECT_MEDIA_IMAGE_REVIEW_SCHEMA,
  coverage: "single-image",
  source,
  summary: "Named fixture only",
  issues: [],
});
test("a bound empty image report cannot imply whole-video or commercial approval", () => {
  const parsed = parseProjectMediaImageReviewReport(report(), source);
  assert.deepEqual(assessProjectMediaImageReview(parsed, source), {
    state: "no-issues-in-reviewed-image",
    blockerCount: 0,
    notChecked: ["story", "motion", "audio", "licensing"],
  });
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.source.image));
  assert.ok(Buffer.byteLength(projectMediaImageReviewPrompt(source)) < 10_000);
});
test("changed candidate, pixels, scope or reviewer makes the old report stale", () => {
  for (const changed of [
    { ...source, candidateDigest: `sha256:${"d".repeat(64)}` },
    { ...source, reviewerAgentVersionId: "different" },
    { ...source, projectId: "different" },
    {
      ...source,
      image: { ...source.image, contentDigest: `sha256:${"d".repeat(64)}` },
    },
  ]) {
    assert.equal(
      assessProjectMediaImageReview(report(), changed).state,
      "stale",
    );
    assert.throws(() => parseProjectMediaImageReviewReport(report(), changed), {
      code: "project_media_image_review_invalid",
    });
  }
});
test("actionable bounded image issues require a real region and a repair recommendation", () => {
  const issue = {
    category: "visual-artifact",
    severity: "blocker",
    region: { left: 0.2, top: 0.1, right: 0.4, bottom: 0.3 },
    message: "Named issue",
    recommendation: "Named repair",
  };
  const parsed = parseProjectMediaImageReviewReport(
    { ...report(), issues: [issue] },
    source,
  );
  assert.equal(assessProjectMediaImageReview(parsed, source).blockerCount, 1);
  for (const bad of [
    { ...issue, region: { ...issue.region, right: 0.1 } },
    { ...issue, category: "commercial-ready" },
    { ...issue, message: "" },
    { ...issue, recommendation: "x".repeat(769) },
  ])
    assert.throws(
      () =>
        parseProjectMediaImageReviewReport(
          { ...report(), issues: [bad] },
          source,
        ),
      { code: "project_media_image_review_invalid" },
    );
});
test("untrusted report cannot add a pass grade, widen coverage or execute getters", () => {
  for (const bad of [
    { ...report(), passed: true },
    { ...report(), coverage: "entire-video" },
    {
      ...report(),
      source: { ...source, mediaUrl: "https://untrusted.example" },
    },
    { ...report(), summary: "x".repeat(1025) },
    new Proxy(report(), {}),
  ])
    assert.throws(() => parseProjectMediaImageReviewReport(bad), {
      code: "project_media_image_review_invalid",
    });
  let called = false;
  const bad = { ...report() };
  Object.defineProperty(bad, "summary", {
    enumerable: true,
    get() {
      called = true;
      throw new Error("must not run");
    },
  });
  assert.throws(() => parseProjectMediaImageReviewReport(bad), {
    code: "project_media_image_review_invalid",
  });
  assert.equal(called, false);
});
