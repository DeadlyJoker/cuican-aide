import assert from "node:assert/strict";
import test from "node:test";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

function responseEvents(number: number, finish = false) {
  const id = `response-${number}`;
  return [
    { type: "response.created", sequence_number: 0, response: { id } },
    ...(finish
      ? [
          {
            type: "response.output_text.delta",
            sequence_number: 1,
            delta: "answer",
          },
        ]
      : []),
    {
      type: "response.completed",
      sequence_number: finish ? 2 : 1,
      response: {
        id,
        status: "completed",
        end_turn: finish,
        output: finish
          ? [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "answer" }],
              },
            ]
          : [],
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 80 },
          output_tokens: finish ? 10 : 0,
          total_tokens: finish ? 110 : 100,
        },
      },
    },
  ];
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip:
      backend === "postgres" &&
      process.env.CREWON_TEST_POSTGRES_URL === undefined,
  };
  for (const scenario of [
    { purpose: "agent", manualCompaction: false, storeResponses: false },
    { purpose: "compaction", manualCompaction: true, storeResponses: false },
    { purpose: "compaction", manualCompaction: true, storeResponses: true },
  ] as const) {
    test(
      `${backend}: ${scenario.purpose} stored=${scenario.storeResponses} stops an empty HTTP response loop and stays terminal after restart`,
      options,
      async (context) => {
        const f = await createFixture(context, {
          backend,
          ...scenario,
          crashAfterCommit: false,
          streamMaxRetries: 1,
          modelResponseEvents: (number) => responseEvents(number, number > 10),
        });
        const before = await f.history();
        const result = await f.worker().wake();
        assert.equal(result.kind, "failed", JSON.stringify(result));
        assert.equal(
          "code" in result && result.code,
          "model_empty_continuation_limit_exceeded",
        );
        assert.equal(f.requests.length, 4);
        assert.equal(f.executions(), 0);
        assert.equal((await f.run())?.status, "failed");
        assert.deepEqual(await f.history(), before);
        assert.equal(await f.compactionCheckpointCount(), 0);
        const calls = await f.callRecords();
        assert.equal(calls.length, 4);
        assert(
          calls.every(
            (call) =>
              call.record.observation.purpose === scenario.purpose &&
              call.record.observation.outcome === "completed",
          ),
        );
        const usage = await f.usageRecords();
        assert.equal(usage.length, 4);
        const accounting = await f.accountingReport();
        assert.equal(accounting.total.usage.inputTokens, 400);
        assert.equal(accounting.total.usage.cacheReadHitRate, 0.8);
        assert.equal(accounting.generations.missingUsage, 0);
        if (scenario.storeResponses) {
          assert.equal(f.requests[1]!.previous_response_id, "response-1");
          assert.deepEqual(f.requests[1]!.input, []);
        } else {
          for (const request of f.requests)
            assert.deepEqual(request, f.requests[0]);
        }
        await f.reopen();
        await f.makeDue();
        assert.equal((await f.worker().wake()).kind, "idle");
        assert.equal(f.requests.length, 4);
        assert.deepEqual(await f.callRecords(), calls);
        assert.deepEqual(await f.usageRecords(), usage);
      },
    );
  }
  for (const storeResponses of [false, true]) {
    test(
      `${backend}: compaction preserves healthy stored=${storeResponses} continuation and reuses its saved result`,
      options,
      async (context) => {
        const f = await createFixture(context, {
          backend,
          storeResponses,
          manualCompaction: true,
          crashAfterCommit: false,
          checkpointPersistenceFailure: "afterCommit",
          modelResponseEvents: (number) => responseEvents(number, number >= 3),
        });
        const before = await f.history();
        assert.equal((await f.worker().wake()).kind, "retried");
        assert.equal(f.requests.length, 3);
        assert.deepEqual(await f.history(), before);
        assert.equal(await f.compactionCheckpointCount(), 1);
        const calls = await f.callRecords();
        const usage = await f.usageRecords();
        assert.equal(usage.length, 3);
        await f.reopen();
        await f.makeDue();
        const result = await f.worker().wake();
        assert.equal(result.kind, "completed", JSON.stringify(result));
        assert.equal(f.requests.length, 3);
        assert.equal(await f.compactionCheckpointCount(), 0);
        assert.deepEqual(await f.callRecords(), calls);
        assert.deepEqual(await f.usageRecords(), usage);
        assert.equal((await f.accountingReport()).total.usage.inputTokens, 300);
        assert.equal(
          (await f.accountingReport()).total.usage.cacheReadHitRate,
          0.8,
        );
        assert.equal(
          (await f.history()).filter((item) => item.type === "compaction")
            .length,
          1,
        );
      },
    );
  }
}
