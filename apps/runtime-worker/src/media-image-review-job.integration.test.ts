import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ThreadApplicationService,
  TurnApplicationService,
  createProjectMediaImageReviewJob,
  parseProjectMediaImageReviewJob,
} from "@crewon/application";
import { mediaImageReviewFixture } from "./media-image-review.test-support.ts";
import { MediaImageReviewKernel } from "./media-image-review-kernel.ts";
const options = { skip: !process.env.CREWON_TEST_FFMPEG, timeout: 30_000 };

test(
  "same review request replays its original Run after send permission is withdrawn",
  options,
  async (t) => {
    const f = await mediaImageReviewFixture(t);
    f.state.send = false;
    const before = f.state.gets;
    const sendDecisions = f.state.sendDecisionCalls;
    const replay = await f.jobService.start(f.reviewStart, {
      signal: new AbortController().signal,
    });
    assert.equal(replay.turn.disposition, "replayed");
    assert.deepEqual(replay.job, f.admitted.job);
    assert.equal(replay.turn.runState.runId, f.accepted.runState.runId);
    assert.equal(f.state.samples, 0);
    // One authorized saved-candidate read, without a thumbnail/send grant or another Run.
    assert.equal(f.state.gets, before);
    assert.equal(f.state.sendDecisionCalls, sendDecisions);
    const db = new DatabaseSync(f.databasePath);
    t.after(() => db.close());
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM project_media_image_review_jobs")
        .get()!.n,
      1,
    );
  },
);

test(
  "new review denied before admission leaves no Run or thread message",
  options,
  async (t) => {
    const f = await mediaImageReviewFixture(t);
    const thread = await new ThreadApplicationService(f.common).createThread(
      f.actor,
      {
        kind: "thread.create",
        title: "Named denied review",
        workspaceId: null,
        idempotencyKey: randomUUID(),
      },
    );
    f.state.send = false;
    await assert.rejects(
      f.jobService.start(
        {
          ...f.reviewStart,
          threadId: thread.state.threadId,
          expectedThreadRevision: thread.state.revision,
          idempotencyKey: randomUUID(),
        },
        { signal: new AbortController().signal },
      ),
    );
    const after = await f.parent.loadThread({
      tenantId: f.actor.tenantId,
      threadId: thread.state.threadId,
    });
    assert.equal(after!.revision, thread.state.revision);
    assert.equal(f.state.samples, 0);
    const db = new DatabaseSync(f.databasePath);
    t.after(() => db.close());
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM run_thread_bindings WHERE thread_id=?",
        )
        .get(thread.state.threadId)!.n,
      0,
    );
  },
);

test(
  "grant revoked after original Turn writes rolls back Run, message, job and receipt together",
  options,
  async (t) => {
    const f = await mediaImageReviewFixture(t);
    const thread = await new ThreadApplicationService(f.common).createThread(
      f.actor,
      {
        kind: "thread.create",
        title: "Named atomic rollback",
        workspaceId: null,
        idempotencyKey: randomUUID(),
      },
    );
    const command = {
      kind: "turn.start" as const,
      threadId: thread.state.threadId,
      expectedThreadRevision: thread.state.revision,
      content: "Named rollback test",
      requestedAgentVersionId: f.route.agentVersionId,
      executionIntent: "none" as const,
      toolPermissionMode: "requestApproval" as const,
      idempotencyKey: randomUUID(),
      route: f.route,
    };
    const turns = new TurnApplicationService(f.common);
    const prepared = await turns.prepareTurn(f.actor, command);
    const event = prepared.run.events[0];
    assert.equal(event!.type, "run.created");
    const {
      schemaVersion: _schema,
      transformation: _transformation,
      contentDigest: _digest,
      ...original
    } = f.admitted.job;
    const job = createProjectMediaImageReviewJob({
      ...original,
      runId: event!.identity.runId,
      threadId: thread.state.threadId,
      createdAt: event!.occurredAt,
    });
    let checks = 0;
    await assert.rejects(
      f.jobs.commit({
        turn: prepared,
        job,
        assertActive: () => {
          if (++checks === 3)
            throw new Error("named grant revoked after writes");
        },
      }),
      /named grant revoked after writes/u,
    );
    assert.equal(checks, 3);
    assert.equal(
      await f.parent.loadRun({ tenantId: f.actor.tenantId, runId: job.runId }),
      null,
    );
    assert.equal(
      await f.jobs.load({
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        runId: job.runId,
      }),
      null,
    );
    assert.equal(await turns.replayTurn(f.actor, command), null);
    assert.equal(
      (await f.parent.loadThread({
        tenantId: f.actor.tenantId,
        threadId: thread.state.threadId,
      }))!.revision,
      thread.state.revision,
    );
    const db = new DatabaseSync(f.databasePath);
    t.after(() => db.close());
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM work_items WHERE run_id=?")
        .get(job.runId)!.n,
      0,
    );
    assert.equal(f.state.samples, 0);
  },
);

test(
  "missing original admission cannot be reconstructed from an ordinary Run or copied report",
  options,
  async (t) => {
    const f = await mediaImageReviewFixture(t);
    await assert.rejects(
      MediaImageReviewKernel.restore({
        kernel: {} as never,
        sources: f.reader,
        store: f.parent,
        scope: {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          runId: f.request.query.runId,
        },
        signal: new AbortController().signal,
      }),
      /media_image_review_admission_missing/u,
    );
    const locator = {
      tenantId: f.actor.tenantId,
      spaceId: "different-space",
      runId: f.admitted.job.runId,
    };
    assert.equal(await f.jobs.load(locator), null);
    const copied = JSON.parse(JSON.stringify(f.admitted.job));
    copied.candidateId = "different-candidate";
    assert.throws(() => parseProjectMediaImageReviewJob(copied));
    assert.equal(f.state.samples, 0);
  },
);

test(
  "an ordinary Turn receipt with copied review content cannot be promoted to an admitted job",
  options,
  async (t) => {
    const f = await mediaImageReviewFixture(t);
    const thread = await new ThreadApplicationService(f.common).createThread(
      f.actor,
      {
        kind: "thread.create",
        title: "Named unadmitted review receipt",
        workspaceId: null,
        idempotencyKey: randomUUID(),
      },
    );
    const idempotencyKey = randomUUID();
    const ordinary = await new TurnApplicationService(f.common).startTurn(
      f.actor,
      {
        kind: "turn.start",
        threadId: thread.state.threadId,
        expectedThreadRevision: thread.state.revision,
        content: f.admitted.turn.messages[0]!.content,
        requestedAgentVersionId: f.route.agentVersionId,
        executionIntent: "none",
        toolPermissionMode: "requestApproval",
        idempotencyKey,
        route: f.route,
      },
    );
    await assert.rejects(
      f.jobService.start(
        {
          ...f.reviewStart,
          threadId: thread.state.threadId,
          expectedThreadRevision: thread.state.revision,
          idempotencyKey,
        },
        { signal: new AbortController().signal },
      ),
      /replay_missing_or_changed/u,
    );
    assert.equal(
      await f.jobs.load({
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        runId: ordinary.runState.runId,
      }),
      null,
    );
    assert.equal(f.state.samples, 0);
  },
);

test(
  "immutable job cannot be edited; damaged schema fails once before any model request",
  options,
  async (t) => {
    const f = await mediaImageReviewFixture(t);
    const db = new DatabaseSync(f.databasePath);
    t.after(() => db.close());
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE project_media_image_review_jobs SET content_digest=? WHERE run_id=?",
          )
          .run(`sha256:${"0".repeat(64)}`, f.admitted.job.runId),
      /immutable/u,
    );
    // Named corruption injection only in the disposable test DB, never the client's profile.
    db.exec("DROP TRIGGER project_media_image_review_jobs_immutable");
    await assert.rejects(
      f.jobs.load({
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        runId: f.admitted.job.runId,
      }),
      /schema_invalid/u,
    );
    const result = await f.worker.wake();
    assert.equal(result.kind, "failed", JSON.stringify(result));
    assert.equal(f.state.samples, 0);
    assert.equal((await f.worker.wake()).kind, "idle");
  },
);
