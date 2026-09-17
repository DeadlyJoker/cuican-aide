import assert from "node:assert/strict";
import test from "node:test";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";
function events(number: number, failed = false) {
  const id = `response-${number}`;
  const output = `summary-${number}`;
  return [
    { type: "response.created", sequence_number: 0, response: { id } },
    ...(failed
      ? []
      : [
          {
            type: "response.output_text.delta",
            sequence_number: 1,
            delta: output,
          },
        ]),
    {
      type: failed ? "response.failed" : "response.completed",
      sequence_number: failed ? 1 : 2,
      response: {
        id,
        status: failed ? "failed" : "completed",
        ...(failed
          ? { error: { code: "context_length_exceeded" } }
          : {
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: output }],
                },
              ],
            }),
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: failed ? 0 : 80 },
          output_tokens: failed ? 0 : 10,
          total_tokens: failed ? 100 : 110,
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
  test(
    `${backend}: durable successful parts and overflow plans resume after restart without resampling`,
    options,
    async (context) => {
      const f = await createFixture(context, {
        backend,
        storeResponses: false,
        crashAfterCommit: false,
        manualCompaction: true,
        initialMessages: [
          { role: "user", content: "first" },
          { role: "user", content: "last" },
        ],
        modelResponseEvents: (n) => events(n, n === 1),
        checkpointPersistenceFailure: "afterCommit",
      });
      const before = await f.history();
      assert.equal((await f.worker().wake()).kind, "retried");
      assert.equal(f.requests.length, 2);
      assert.equal(await f.compactionCheckpointCount(), 1);
      assert.deepEqual(await f.history(), before);
      await f.reopen();
      await f.makeDue();
      const result = await f.worker().wake();
      assert.equal(result.kind, "completed", JSON.stringify(result));
      assert.equal(f.requests.length, 3);
      assert.deepEqual((f.requests[2]!.input as unknown[]).slice(0, -1), [
        { role: "user", content: "last" },
      ]);
      const history = await f.history();
      const compacted = history.at(-1);
      assert.equal(compacted?.type, "compaction");
      if (compacted?.type === "compaction") {
        assert.ok(compacted.summary.includes("summary-2"));
        assert.ok(compacted.summary.includes("summary-3"));
      }
      assert.equal((await f.callRecords()).length, 3);
      assert.equal((await f.usageRecords()).length, 3);
      const event = (await f.events()).find(
        (event) => event.type === "context.compacted",
      );
      if (event?.type !== "context.compacted")
        throw new Error("compaction missing");
      assert.equal(event.data.inputTokens, 200);
      assert.equal(event.data.cachedInputTokens, 160);
      assert.equal(await f.compactionCheckpointCount(), 0);
      await f.reopen();
      await f.worker().wake();
      assert.equal(f.requests.length, 3);
      assert.deepEqual(await f.history(), history);
    },
  );
  test(
    `${backend}: fully saved summary survives a canonical commit failure with no additional generation`,
    options,
    async (context) => {
      let fail = true;
      const f = await createFixture(context, {
        backend,
        storeResponses: false,
        crashAfterCommit: false,
        manualCompaction: true,
        modelResponseEvents: (n) => events(n),
        beforeCompactionCommit: () => {
          if (fail) {
            fail = false;
            throw new Error("before_commit");
          }
        },
      });
      const before = await f.history();
      assert.equal((await f.worker().wake()).kind, "retried");
      assert.equal(f.requests.length, 1);
      assert.deepEqual(await f.history(), before);
      assert.equal(await f.compactionCheckpointCount(), 1);
      await f.reopen();
      await f.makeDue();
      assert.equal((await f.worker().wake()).kind, "completed");
      assert.equal(f.requests.length, 1);
      assert.equal((await f.usageRecords()).length, 1);
      assert.equal(await f.compactionCheckpointCount(), 0);
    },
  );
  test(
    `${backend}: changed instructions reject checkpoint reuse before requesting another model result`,
    options,
    async (context) => {
      const instructions = { value: "original instructions" };
      const f = await createFixture(context, {
        backend,
        storeResponses: false,
        crashAfterCommit: false,
        manualCompaction: true,
        modelResponseEvents: (n) => events(n),
        checkpointPersistenceFailure: "afterCommit",
        instructions,
      });
      const before = await f.history();
      assert.equal((await f.worker().wake()).kind, "retried");
      instructions.value = "changed instructions";
      await f.reopen();
      await f.makeDue();
      const result = await f.worker().wake();
      assert.equal(result.kind, "failed");
      if (result.kind === "failed")
        assert.equal(result.code, "compaction_checkpoint_context_mismatch");
      assert.equal(f.requests.length, 1);
      assert.deepEqual(await f.history(), before);
      assert.equal(await f.compactionCheckpointCount(), 0);
    },
  );
  test(
    `${backend}: checkpoint retirement and canonical compaction roll back together`,
    options,
    async (context) => {
      const f = await createFixture(context, {
        backend,
        storeResponses: false,
        crashAfterCommit: false,
        manualCompaction: true,
        modelResponseEvents: (n) => events(n),
      });
      const before = await f.history();
      await f.failCompactionRetirement(true);
      assert.equal((await f.worker().wake()).kind, "retried");
      assert.deepEqual(await f.history(), before);
      assert.equal(await f.compactionCheckpointCount(), 1);
      assert.equal(f.requests.length, 1);
      await f.failCompactionRetirement(false);
      await f.reopen();
      await f.makeDue();
      assert.equal((await f.worker().wake()).kind, "completed");
      assert.equal(f.requests.length, 1);
      assert.equal(await f.compactionCheckpointCount(), 0);
    },
  );
  test(
    `${backend}: corrupted saved summaries fail before another model request`,
    options,
    async (context) => {
      const f = await createFixture(context, {
        backend,
        storeResponses: false,
        crashAfterCommit: false,
        manualCompaction: true,
        modelResponseEvents: (n) => events(n),
        checkpointPersistenceFailure: "afterCommit",
      });
      const before = await f.history();
      assert.equal((await f.worker().wake()).kind, "retried");
      await f.corruptCompactionCheckpoint();
      await f.reopen();
      await f.makeDue();
      const result = await f.worker().wake();
      assert.equal(result.kind, "failed");
      if (result.kind === "failed")
        assert.equal(result.code, "compaction_checkpoint_record_invalid");
      assert.equal(f.requests.length, 1);
      assert.deepEqual(await f.history(), before);
      assert.equal(await f.compactionCheckpointCount(), 0);
    },
  );
  test(
    `${backend}: cancellation retires staging atomically without completing a partial compaction`,
    options,
    async (context) => {
      const f = await createFixture(context, {
        backend,
        storeResponses: false,
        crashAfterCommit: false,
        manualCompaction: true,
        modelResponseEvents: (n) => events(n),
        checkpointPersistenceFailure: "afterCommit",
      });
      const before = await f.history();
      assert.equal((await f.worker().wake()).kind, "retried");
      assert.equal(await f.compactionCheckpointCount(), 1);
      await f.cancel();
      await f.makeDue();
      assert.equal((await f.worker().wake()).kind, "canceled");
      assert.equal(f.requests.length, 1);
      const history = await f.history();
      assert.deepEqual(history.slice(0, before.length), before);
      assert.equal(history.length, before.length + 1);
      assert.equal(history.at(-1)?.type, "message");
      assert.equal(
        (await f.events()).filter((event) => event.type === "context.compacted")
          .length,
        0,
      );
      assert.equal(await f.compactionCheckpointCount(), 0);
    },
  );
}
