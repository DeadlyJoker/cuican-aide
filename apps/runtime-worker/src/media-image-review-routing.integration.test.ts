import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { compileAgentVersion } from "@crewon/agent-version";
import { mediaImageReviewFixture } from "./media-image-review.test-support.ts";
import { ConfiguredAgentVersionRuntimeFactory } from "./configured-agent-version-runtime-factory.ts";
import { MediaImageReviewRoutingKernel } from "./media-image-review-routing-kernel.ts";
const options = { skip: !process.env.CREWON_TEST_FFMPEG, timeout: 30_000 };

test(
  "actual configured reviewer runtime is resolved by Worker and restores its durable report",
  options,
  async (t) => {
    const f = await mediaImageReviewFixture(t, {
      execution: "configured-review",
    });
    assert.ok(
      f.configuredRuntime?.kernel instanceof MediaImageReviewRoutingKernel,
    );
    const outcome = await f.worker.wake();
    assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
    assert.equal(f.state.samples, 1);
    assert.ok(
      JSON.stringify(f.state.pixelRequests[0]).includes(
        "data:image/jpeg;base64,",
      ),
    );
    const currentThread = await f.parent.loadThread({
      tenantId: f.actor.tenantId,
      threadId: f.thread.state.threadId,
    });
    const second = await f.jobService.start(
      {
        ...f.reviewStart,
        expectedThreadRevision: currentThread!.revision,
        idempotencyKey: randomUUID(),
      },
      { signal: new AbortController().signal },
    );
    assert.notEqual(second.job.runId, f.admitted.job.runId);
    assert.equal((await f.worker.wake()).kind, "completed");
    assert.equal(f.state.samples, 2);
    f.state.send = false;
    const cold = await f.coldReport();
    assert.equal(cold.state, "ready");
    assert.equal(f.state.samples, 2);
  },
);

test(
  "ordinary Kernel cannot consume a real admitted image-review job or synthesize a report",
  options,
  async (t) => {
    const f = await mediaImageReviewFixture(t, {
      execution: "ordinary-kernel",
    });
    const outcome = await f.worker.wake();
    assert.equal(outcome.kind, "failed", JSON.stringify(outcome));
    if (outcome.kind === "failed")
      assert.equal(outcome.code, "media_image_review_runtime_required");
    assert.equal(f.state.samples, 0);
    assert.equal((await f.worker.wake()).kind, "idle");
  },
);

test(
  "review binding rejects workspace, actor tenant and tools/compaction drift before transport creation",
  options,
  async (t) => {
    const f = await mediaImageReviewFixture(t);
    assert.throws(
      () =>
        new ConfiguredAgentVersionRuntimeFactory([
          {
            ...f.factoryBinding,
            savedImageReview: {
              ...f.factoryBinding.savedImageReview,
              actor: { ...f.actor, tenantId: "other" },
            },
          },
        ]),
      /binding_invalid/u,
    );
    assert.throws(
      () =>
        new ConfiguredAgentVersionRuntimeFactory([
          { ...f.factoryBinding, workspaceBindingId: "workspace" },
        ]),
      /binding_invalid/u,
    );
    let opened = 0;
    const { contentDigest: _digest, ...versionSource } = f.reviewVersion;
    const changed = compileAgentVersion(
      {
        ...versionSource,
        schemaVersion: "crewon.agent-version-source.v0",
        model: { ...versionSource.model, autoCompactAtTokens: 1000 },
      },
      f.common.digester,
    );
    const factory = new ConfiguredAgentVersionRuntimeFactory([
      {
        ...f.factoryBinding,
        contentDigest: changed.contentDigest,
        createTransport: () => {
          opened++;
          return f.factoryBinding.createTransport();
        },
      },
    ]);
    await assert.rejects(
      factory.create({ tenantId: f.actor.tenantId, version: changed }),
      /version_invalid/u,
    );
    assert.equal(opened, 0);
    assert.equal(f.state.samples, 0);
  },
);

test(
  "closed routing owner rejects new execution without another model call",
  options,
  async (t) => {
    const f = await mediaImageReviewFixture(t, {
      execution: "configured-review",
    });
    await f.configuredRuntime!.close!();
    const outcome = await f.worker.wake();
    assert.equal(outcome.kind, "failed", JSON.stringify(outcome));
    assert.equal(f.state.samples, 0);
  },
);

test(
  "runtime close aborts and joins an actual in-flight HTTP review before returning",
  options,
  async (t) => {
    const f = await mediaImageReviewFixture(t, {
      execution: "configured-review",
    });
    let entered!: () => void, resume!: () => void;
    const received = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    t.after(() => {
      resume();
    });
    f.state.beforeResponse = async () => {
      entered();
      await held;
    };
    const execution = f.worker.wake();
    await Promise.race([
      received,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("named review HTTP request not observed")),
          2000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(f.state.samples, 1);
    await f.configuredRuntime!.close!();
    const outcome = await execution;
    assert.equal(outcome.kind, "failed", JSON.stringify(outcome));
    assert.equal(f.state.samples, 1);
    resume();
  },
);
