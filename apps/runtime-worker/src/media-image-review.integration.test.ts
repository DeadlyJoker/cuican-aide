import assert from "node:assert/strict";
import test from "node:test";
import { mediaImageReviewFixture } from "./media-image-review.test-support.ts";
import { MediaReviewImageError } from "./media-review-image-encoder.ts";
const options = { skip: !process.env.CREWON_TEST_FFMPEG, timeout: 30_000 };
test(
  "a final source check cannot retry a billed review even if a dependency reports busy",
  options,
  async (t) => {
    const f = await mediaImageReviewFixture(t);
    f.state.afterModel = () => {
      f.state.activeFailure = new MediaReviewImageError(
        "media_review_image_busy",
      );
    };
    const result = await f.worker.wake();
    assert.equal(result.kind, "failed", JSON.stringify(result));
    assert.equal(f.state.samples, 1);
    assert.equal((await f.worker.wake()).kind, "idle");
    assert.equal(f.state.samples, 1);
  },
);
test(
  "real Worker reviews encrypted candidate pixels through local HTTP and cold-restores its durable bound report",
  options,
  async (t) => {
    const f = await mediaImageReviewFixture(t);
    const before = { posts: f.controls.posts, gets: f.state.gets };
    const result = await f.worker.wake();
    assert.equal(result.kind, "completed", JSON.stringify(result));
    assert.equal(result.runId, f.accepted.runState.runId);
    assert.equal(f.state.samples, 1);
    const body = f.state.pixelRequests[0] as {
      input: Array<{ content: unknown }>;
    };
    const wire = JSON.stringify(body);
    assert.ok(wire.includes("data:image/jpeg;base64,"));
    const report = await f.kernel.loadCompletedReport({
      signal: new AbortController().signal,
    });
    assert.equal(report.state, "ready");
    if (report.state !== "ready") throw new Error("named missing report");
    assert.deepEqual(
      [report.report.source.image.width, report.report.source.image.height],
      [512, 384],
    );
    assert.equal(
      report.report.source.candidateDigest,
      f.saved.candidate.contentDigest,
    );
    assert.deepEqual(report.assessment.notChecked, [
      "story",
      "motion",
      "audio",
      "licensing",
    ]);
    const events = await f.parent.listRunEvents(
      { tenantId: f.actor.tenantId, runId: f.accepted.runState.runId },
      0,
      1000,
    );
    assert.equal(
      events.filter((event) => event.type === "run.completed").length,
      1,
    );
    assert.ok(!JSON.stringify(events).includes("data:image"));
    const history = await f.parent.listModelHistoryItems(
      { tenantId: f.actor.tenantId, threadId: f.accepted.runState.threadId },
      0,
      128,
    );
    assert.ok(!JSON.stringify(history).includes("data:image"));
    const calls = await f.parent.listModelCalls({
      tenantId: f.actor.tenantId,
      runId: f.accepted.runState.runId,
      afterOrder: 0,
      limit: 10,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.record.observation.outcome, "completed");
    f.state.send = false;
    const cold = await f.coldReport();
    assert.deepEqual(cold, report);
    assert.equal(f.state.samples, 1);
    assert.equal(f.controls.posts, before.posts);
    assert.equal(f.state.gets, before.gets);
  },
);
test(
  "an artifact read cannot grant model image transmission",
  options,
  async (t) => {
    const f = await mediaImageReviewFixture(t);
    f.state.send = false;
    const result = await f.worker.wake();
    assert.equal(result.kind, "failed", JSON.stringify(result));
    assert.equal(f.state.samples, 0);
    assert.equal((await f.worker.wake()).kind, "idle");
    assert.equal(f.state.samples, 0);
    await assert.rejects(
      f.kernel.loadCompletedReport({ signal: new AbortController().signal }),
      { code: "media_image_review_report_not_completed" },
    );
  },
);
test(
  "source permission revoked during the model call cannot publish a completed review",
  options,
  async (t) => {
    const f = await mediaImageReviewFixture(t);
    f.state.afterModel = () => {
      f.state.read = false;
    };
    const result = await f.worker.wake();
    assert.equal(result.kind, "failed", JSON.stringify(result));
    assert.equal(f.state.samples, 1);
    assert.equal((await f.worker.wake()).kind, "idle");
    assert.equal(f.state.samples, 1);
    const run = await f.parent.loadRun({
      tenantId: f.actor.tenantId,
      runId: f.accepted.runState.runId,
    });
    assert.equal(run?.status, "failed");
    const calls = await f.parent.listModelCalls({
      tenantId: f.actor.tenantId,
      runId: f.accepted.runState.runId,
      afterOrder: 0,
      limit: 10,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.record.observation.outcome, "completed");
  },
);
test(
  "a model cannot substitute another candidate or claim whole-video coverage",
  options,
  async (t) => {
    const f = await mediaImageReviewFixture(t);
    f.state.mutate = (report) => ({
      ...report,
      coverage: "entire-video",
      source: { ...report.source, candidateId: "fabricated" },
    });
    const result = await f.worker.wake();
    assert.equal(result.kind, "failed", JSON.stringify(result));
    if (result.kind === "failed")
      assert.equal(result.code, "media_image_review_report_invalid");
    await assert.rejects(
      f.kernel.loadCompletedReport({ signal: new AbortController().signal }),
      { code: "media_image_review_report_not_completed" },
    );
  },
);
