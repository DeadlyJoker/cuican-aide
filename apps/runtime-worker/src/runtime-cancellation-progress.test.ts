import assert from "node:assert/strict";
import test from "node:test";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";
import type { RuntimeWorkerOutcome } from "./runtime-worker.ts";

type Fixture = Awaited<ReturnType<typeof createFixture>>;
async function finishCancellation(f: Fixture, result: RuntimeWorkerOutcome) {
  for (
    let passes = 0;
    result.kind === "retried" &&
    result.code === "run_cancellation_progress_loading";
    passes++
  ) {
    assert(passes < 60);
    assert(f.runEventReads.reduce((n, read) => n + read.limit, 0) <= 4096);
    const cursor = f.runEventReads.at(-1)!.afterSequence;
    await f.reopen();
    await f.makeDue();
    f.runEventReads.length = 0;
    result = await f.worker().wake();
    assert(f.runEventReads.every((read) => read.afterSequence > cursor));
  }
  assert.equal(result.kind, "canceled", JSON.stringify(result));
  assert.equal(await f.executionProgressCount(), 0);
  return result;
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip:
      backend === "postgres" &&
      process.env.CREWON_TEST_POSTGRES_URL === undefined,
  };
  for (const state of ["cold", "warm", "corrupt"] as const) {
    test(
      `${backend}: ${state} cancellation of a 5,000-event Run is resumable and generates no model calls`,
      options,
      async (context) => {
        const f = await createFixture(context, {
          backend,
          initialRunEventCount: 5000,
          observeRunEventReads: true,
          storeResponses: true,
          crashAfterCommit: false,
        });
        const history = await f.history();
        let warmCursor = 0;
        if (state !== "cold") {
          const warming = await f.worker().wake();
          assert.equal(warming.kind, "retried");
          assert.equal(
            "code" in warming && warming.code,
            "run_execution_progress_loading",
          );
          warmCursor = f.runEventReads.at(-1)!.afterSequence;
          assert.equal(f.requests.length, 0);
          if (state === "corrupt") await f.corruptExecutionProgress();
          await f.reopen();
        }
        await f.cancel();
        await f.makeDue();
        f.runEventReads.length = 0;
        const result = await f.worker().wake();
        if (state === "warm")
          assert(
            f.runEventReads.every((read) => read.afterSequence > warmCursor),
          );
        else {
          assert.equal(result.kind, "retried", JSON.stringify(result));
          assert.equal(
            "code" in result && result.code,
            "run_cancellation_progress_loading",
          );
          assert.deepEqual(await f.history(), history);
          assert.equal(f.runEventReads[0]!.afterSequence, 0);
        }
        await finishCancellation(f, result);
        assert.equal(f.requests.length, 0);
        assert.equal(f.executions(), 0);
        const finalHistory = await f.history();
        assert.deepEqual(finalHistory.slice(0, history.length), history);
        assert.equal(finalHistory.length, history.length + 1);
        const marker = finalHistory.at(-1)!;
        assert.equal(marker.type, "message");
        assert.equal("source" in marker && marker.source, "turn_aborted");
      },
    );
  }
  test(
    `${backend}: warm cancellation closes pending tools in order without scanning the 5,000-event prefix`,
    options,
    async (context) => {
      const f = await createFixture(context, {
        backend,
        initialRunEventCount: 5000,
        observeRunEventReads: true,
        storeResponses: true,
        crashAfterCommit: true,
        toolCount: 3,
      });
      let result = await f.worker().wake();
      for (
        let passes = 0;
        result.kind === "retried" &&
        result.code === "run_execution_progress_loading";
        passes++
      ) {
        assert(passes < 60);
        await f.reopen();
        await f.makeDue();
        result = await f.worker().wake();
      }
      assert.equal(result.kind, "retried", JSON.stringify(result));
      assert.equal("code" in result && result.code, "execution_internal");
      assert.equal(f.sampleCommits.length, 1);
      const prior = await f.history();
      const calls = prior.filter((item) => item.type === "tool_call");
      assert.equal(calls.length, 3);
      await f.cancel();
      await f.reopen();
      await f.makeDue();
      f.runEventReads.length = 0;
      await finishCancellation(f, await f.worker().wake());
      assert(f.runEventReads.every((read) => read.afterSequence >= 5002));
      assert(f.runEventReads.reduce((n, read) => n + read.limit, 0) < 30);
      assert.equal(f.requests.length, 1);
      assert.equal(f.executions(), 0);
      const history = await f.history();
      assert.deepEqual(history.slice(0, prior.length), prior);
      assert.deepEqual(
        history
          .slice(prior.length, -1)
          .map((item) =>
            item.type === "tool_result"
              ? [item.callId, item.status]
              : item.type,
          ),
        calls.map((item) => [item.callId, "aborted"]),
      );
      assert.equal(history.length, prior.length + 4);
    },
  );
  for (const progressResetFailure of ["beforeCommit", "afterCommit"] as const) {
    test(
      `${backend}: cancellation recovers a corrupt checkpoint after reset ${progressResetFailure} failure`,
      options,
      async (context) => {
        const f = await createFixture(context, {
          backend,
          initialRunEventCount: 5000,
          observeRunEventReads: true,
          storeResponses: true,
          crashAfterCommit: false,
          progressResetFailure,
        });
        await f.worker().wake();
        await f.corruptExecutionProgress();
        await f.cancel();
        await f.reopen();
        await f.makeDue();
        const failedReset = await f.worker().wake();
        assert.equal(failedReset.kind, "retried", JSON.stringify(failedReset));
        assert.equal(f.requests.length, 0);
        assert.equal(
          await f.executionProgressCount(),
          progressResetFailure === "beforeCommit" ? 1 : 0,
        );
        assert.equal((await f.history()).length, 1);
        await f.reopen();
        await f.makeDue();
        f.runEventReads.length = 0;
        await finishCancellation(f, await f.worker().wake());
        assert.equal(f.requests.length, 0);
        assert.equal((await f.history()).length, 2);
      },
    );
  }
  for (const progressSaveFailure of ["beforeCommit", "afterCommit"] as const) {
    test(
      `${backend}: cancellation ${progressSaveFailure} progress failure yields before spending a second replay budget`,
      options,
      async (context) => {
        const f = await createFixture(context, {
          backend,
          initialRunEventCount: 5000,
          observeRunEventReads: true,
          storeResponses: true,
          crashAfterCommit: false,
          progressSaveFailure,
        });
        await f.cancel();
        const failed = await f.worker().wake();
        assert.equal(failed.kind, "retried", JSON.stringify(failed));
        assert.equal(
          "code" in failed && failed.code,
          progressSaveFailure === "beforeCommit"
            ? "progress_save_before_commit"
            : "progress_save_after_commit",
        );
        assert(f.runEventReads.reduce((n, read) => n + read.limit, 0) <= 4096);
        assert.equal(
          await f.executionProgressCount(),
          progressSaveFailure === "afterCommit" ? 1 : 0,
        );
        assert.equal((await f.history()).length, 1);
        assert.equal(f.requests.length, 0);
        const priorCursor = f.runEventReads.at(-1)!.afterSequence;
        await f.reopen();
        await f.makeDue();
        f.runEventReads.length = 0;
        const next = await f.worker().wake();
        if (progressSaveFailure === "afterCommit")
          assert(
            f.runEventReads.every((read) => read.afterSequence > priorCursor),
          );
        else assert.equal(f.runEventReads[0]!.afterSequence, 0);
        await finishCancellation(f, next);
        assert.equal(f.requests.length, 0);
        assert.equal((await f.history()).length, 2);
      },
    );
  }
  test(
    `${backend}: an expired lease during cancellation replay writes no checkpoint or aborted history`,
    options,
    async (context) => {
      let f!: Fixture,
        expired = false;
      f = await createFixture(context, {
        backend,
        initialRunEventCount: 5000,
        observeRunEventReads: true,
        storeResponses: true,
        crashAfterCommit: false,
        afterRunEventRead: async () => {
          if (!expired) {
            expired = true;
            await f.expireLease();
          }
        },
      });
      await f.cancel();
      const lost = await f.worker().wake();
      assert.equal(lost.kind, "leaseLost", JSON.stringify(lost));
      assert.equal(await f.executionProgressCount(), 0);
      assert.equal((await f.history()).length, 1);
      assert.equal(f.requests.length, 0);
      assert(f.runEventReads.reduce((n, read) => n + read.limit, 0) <= 4096);
      await f.reopen();
      await f.makeDue();
      f.runEventReads.length = 0;
      await finishCancellation(f, await f.worker().wake());
      assert.equal(f.requests.length, 0);
      assert.equal((await f.history()).length, 2);
    },
  );
  test(
    `${backend}: closing during cancellation replay prevents late progress writes and resumes on reopen`,
    options,
    async (context) => {
      let release!: () => void, enter!: () => void;
      const waiting = new Promise<void>((resolve) => {
          release = resolve;
        }),
        entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
      context.after(release);
      let held = false;
      const f = await createFixture(context, {
        backend,
        initialRunEventCount: 5000,
        observeRunEventReads: true,
        storeResponses: true,
        crashAfterCommit: false,
        afterRunEventRead: async () => {
          if (!held) {
            held = true;
            enter();
            await waiting;
          }
        },
      });
      await f.cancel();
      const wake = f.worker().wake();
      await entered;
      await f.worker().close();
      const stopped = await wake;
      assert.notEqual(stopped.kind, "canceled");
      assert.equal(await f.executionProgressCount(), 0);
      assert.equal((await f.history()).length, 1);
      assert.equal(f.requests.length, 0);
      release();
      await new Promise((resolve) => setImmediate(resolve));
      await f.expireLease();
      await f.reopen();
      await f.makeDue();
      f.runEventReads.length = 0;
      await finishCancellation(f, await f.worker().wake());
      assert.equal(f.requests.length, 0);
      assert.equal((await f.history()).length, 2);
    },
  );
}
