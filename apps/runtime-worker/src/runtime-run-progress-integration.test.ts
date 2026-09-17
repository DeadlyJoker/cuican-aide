import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: a 5,000-event legacy Run prewarms in resumable bounded passes and resumes from its warm cursor`,
    {
      skip:
        backend === "postgres" &&
        process.env.CREWON_TEST_POSTGRES_URL === undefined,
    },
    async (context) => {
      let lost = true;
      const f = await createFixture(context, {
        runIdPrefix: randomUUID(),
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        initialRunEventCount: 5000,
        observeRunEventReads: true,
        afterAssistantSampleCommitted: async () => {
          if (lost) {
            lost = false;
            throw new Error("progress_warm_ack_lost");
          }
        },
        modelResponseEvents: (n) => [
          {
            type: "response.created",
            sequence_number: 0,
            response: { id: `response-${n}` },
          },
          ...(n === 1
            ? []
            : [
                {
                  type: "response.output_text.delta",
                  sequence_number: 1,
                  delta: "done",
                },
              ]),
          {
            type: "response.completed",
            sequence_number: n === 1 ? 1 : 2,
            response: {
              id: `response-${n}`,
              status: "completed",
              end_turn: n > 1,
              output:
                n === 1
                  ? []
                  : [
                      {
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "done" }],
                      },
                    ],
              usage: {
                input_tokens: 100,
                input_tokens_details: { cached_tokens: 80 },
                output_tokens: n === 1 ? 0 : 1,
                total_tokens: n === 1 ? 100 : 101,
              },
            },
          },
        ],
      });
      let outcome = await f.worker().wake();
      assert.equal(outcome.kind, "retried", JSON.stringify(outcome));
      assert.equal(
        "code" in outcome && outcome.code,
        "run_execution_progress_loading",
      );
      assert.equal(f.requests.length, 0);
      assert.equal(await f.executionProgressCount(), 1);
      assert(
        f.runEventReads.reduce((total, read) => total + read.limit, 0) <= 4096,
      );
      let passes = 1;
      while (
        "code" in outcome &&
        outcome.code === "run_execution_progress_loading"
      ) {
        assert(passes++ < 60);
        const previousCursor = f.runEventReads.at(-1)!.afterSequence;
        await f.reopen();
        await f.makeDue();
        f.runEventReads.length = 0;
        outcome = await f.worker().wake();
        assert(
          f.runEventReads.every((read) => read.afterSequence > previousCursor),
        );
      }
      assert.equal(outcome.kind, "retried", JSON.stringify(outcome));
      assert.equal("code" in outcome && outcome.code, "progress_warm_ack_lost");
      assert.equal(f.requests.length, 1);
      await f.reopen();
      await f.makeDue();
      f.runEventReads.length = 0;
      const completed = await f.worker().wake();
      assert.equal(completed.kind, "completed", JSON.stringify(completed));
      assert(f.runEventReads.every((read) => read.afterSequence >= 5002));
      assert(
        f.runEventReads.reduce((total, read) => total + read.limit, 0) < 25,
      );
      assert.equal(f.requests.length, 2);
      assert.equal(f.requests[1]!.previous_response_id, "response-1");
      assert.deepEqual(f.requests[1]!.input, []);
      assert.equal((await f.accountingReport()).total.usage.inputTokens, 200);
      assert.equal((await f.history()).length, 2);
      assert.equal(await f.executionProgressCount(), 0);
    },
  );
}

for (const backend of ["sqlite", "postgres"] as const) {
  for (const action of ["cancel", "corrupt"] as const) {
    test(
      `${backend}: ${action} during progress prewarm stops before model generation and retires staging`,
      {
        skip:
          backend === "postgres" &&
          process.env.CREWON_TEST_POSTGRES_URL === undefined,
      },
      async (context) => {
        const f = await createFixture(context, {
          runIdPrefix: randomUUID(),
          backend,
          storeResponses: true,
          crashAfterCommit: false,
          initialRunEventCount: 5000,
        });
        const pending = await f.worker().wake();
        assert.equal(pending.kind, "retried", JSON.stringify(pending));
        assert.equal(
          "code" in pending && pending.code,
          "run_execution_progress_loading",
        );
        assert.equal(await f.executionProgressCount(), 1);
        if (action === "cancel") await f.cancel();
        else await f.corruptExecutionProgress();
        await f.reopen();
        await f.makeDue();
        const result = await f.worker().wake();
        assert.equal(
          result.kind,
          action === "cancel" ? "canceled" : "failed",
          JSON.stringify(result),
        );
        if (action === "corrupt")
          assert.equal(
            "code" in result && result.code,
            "run_execution_progress_record_invalid",
          );
        assert.equal(f.requests.length, 0);
        assert.equal(await f.executionProgressCount(), 0);
        assert.equal((await f.history()).length, action === "cancel" ? 2 : 1);
      },
    );
  }
}

for (const backend of ["sqlite", "postgres"] as const) {
  for (const progressSaveFailure of ["beforeCommit", "afterCommit"] as const) {
    test(
      `${backend}: ${progressSaveFailure} progress save failure resumes before any model generation`,
      {
        skip:
          backend === "postgres" &&
          process.env.CREWON_TEST_POSTGRES_URL === undefined,
      },
      async (context) => {
        const f = await createFixture(context, {
          runIdPrefix: randomUUID(),
          backend,
          storeResponses: true,
          crashAfterCommit: false,
          initialRunEventCount: 100,
          observeRunEventReads: true,
          progressSaveFailure,
          modelResponseEvents: () => [
            {
              type: "response.created",
              sequence_number: 0,
              response: { id: "final-response" },
            },
            {
              type: "response.output_text.delta",
              sequence_number: 1,
              delta: "done",
            },
            {
              type: "response.completed",
              sequence_number: 2,
              response: {
                id: "final-response",
                status: "completed",
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "done" }],
                  },
                ],
                usage: {
                  input_tokens: 100,
                  output_tokens: 1,
                  total_tokens: 101,
                },
              },
            },
          ],
        });
        const before = await f.worker().wake();
        assert.equal(before.kind, "retried", JSON.stringify(before));
        assert.equal(f.requests.length, 0);
        assert.equal(
          await f.executionProgressCount(),
          progressSaveFailure === "afterCommit" ? 1 : 0,
        );
        await f.reopen();
        await f.makeDue();
        f.runEventReads.length = 0;
        const result = await f.worker().wake();
        assert.equal(result.kind, "completed", JSON.stringify(result));
        if (progressSaveFailure === "afterCommit") {
          assert(f.runEventReads.every((read) => read.afterSequence > 0));
          assert(
            f.runEventReads.reduce((total, read) => total + read.limit, 0) <= 2,
          );
        } else assert(f.runEventReads.some((read) => read.afterSequence === 0));
        assert.equal(f.requests.length, 1);
        assert.equal((await f.accountingReport()).total.usage.inputTokens, 100);
        assert.equal(await f.executionProgressCount(), 0);
      },
    );
  }
}
