import assert from "node:assert/strict";
import test from "node:test";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

const response = {
  id: "response-1",
  status: "completed",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "answer" }],
    },
  ],
  usage: {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 80 },
    output_tokens: 10,
    total_tokens: 110,
  },
};
function events(value: Record<string, unknown> = response) {
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: value.id },
    },
    ...(value.status === "completed"
      ? [
          {
            type: "response.output_text.delta",
            sequence_number: 1,
            delta: "answer",
          },
        ]
      : []),
    {
      type: `response.${value.status}`,
      sequence_number: value.status === "completed" ? 2 : 1,
      response: value,
    },
  ];
}
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip:
      backend === "postgres" &&
      process.env.CREWON_TEST_POSTGRES_URL === undefined,
  };
  for (const storeResponses of [false, true]) {
    test(`${backend}: actual HTTP body interruption recovers with storeResponses=${storeResponses} and keeps missing usage unknown`, options, async (context) => {
      const fixture = await createFixture(context, {
        backend,
        storeResponses,
        crashAfterCommit: false,
        streamMaxRetries: 1,
        modelResponseEvents: (number) => events({ ...response, id: `response-${number}` }),
        interruptFirstStreamAfterEvents: 2,
        retrievedResponse: response,
      });
      assert.equal((await fixture.worker().wake()).kind, "completed");
      assert.equal(fixture.requests.length, storeResponses ? 1 : 2);
      assert.equal(fixture.retrievals(), storeResponses ? 1 : 0);
      const calls = await fixture.callRecords();
      assert.deepEqual(calls.map(row => [row.record.observation.operation, row.record.observation.outcome]), [["generate", "failed"], [storeResponses ? "retrieve" : "generate", "completed"]]);
      assert.equal((await fixture.usageRecords()).length, 1);
      const report = await fixture.accountingReport();
      assert.equal(report.total.usage.inputTokens, 100);
      assert.equal(report.total.usage.cacheReadHitRate, 0.8);
      // With storage, the failed generation is covered by the exact response's
      // retrieved usage; a regenerated response leaves the original use unknown.
      assert.equal(report.generations.missingUsage, storeResponses ? 0 : 1);
      const history = await fixture.history();
      await fixture.reopen();
      assert.deepEqual(await fixture.history(), history);
      assert.deepEqual(await fixture.callRecords(), calls);
    });
  }
  test(
    `${backend}: inventories a retry with no usage and the successful call without changing model input`,
    options,
    async (context) => {
      const fixture = await createFixture(context, {
        backend,
        storeResponses: false,
        crashAfterCommit: false,
        streamMaxRetries: 1,
        modelResponseEvents: (n) =>
          n === 1
            ? events({
                id: "response-unknown-usage",
                status: "failed",
                error: { code: "server_error" },
              })
            : events(),
      });
      assert.equal((await fixture.worker().wake()).kind, "completed");
      const calls = await fixture.callRecords();
      assert.equal(calls.length, 2);
      assert.deepEqual(
        calls.map((row) => [
          row.record.observation.operation,
          row.record.observation.outcome,
        ]),
        [
          ["generate", "failed"],
          ["generate", "completed"],
        ],
      );
      assert.equal(
        calls[0]?.record.observation.providerResponseId,
        "response-unknown-usage",
      );
      assert.equal(calls[1]?.record.observation.purpose, "agent");
      const usage = await fixture.usageRecords();
      assert.equal(usage.length, 1);
      assert.equal(
        usage[0]?.record.observation.callId,
        calls[1]?.record.observation.callId,
      );
      assert.deepEqual(fixture.requests[0], fixture.requests[1]);
      assert(!JSON.stringify(fixture.requests).includes("callId"));
      await fixture.reopen();
      assert.deepEqual(await fixture.callRecords(), calls);
      const report = await fixture.accountingReport();
      assert.equal(report.generations.persistedUsageCoverage, 0.5);
      assert.equal(report.total.usage.cacheReadHitRate, 0.8);
      assert.equal(report.total.usage.inputTokens, 100);
      assert.equal(report.generations.missingUsage, 1);
    },
  );
  for (const failure of [
    "beginBeforeCommit",
    "beginAfterCommit",
    "finishBeforeCommit",
    "finishAfterCommit",
  ] as const) {
    test(
      `${backend}: ${failure} accounting failure cannot trigger another generation`,
      options,
      async (context) => {
        const fixture = await createFixture(context, {
          backend,
          storeResponses: false,
          crashAfterCommit: false,
          streamMaxRetries: 3,
          callPersistenceFailure: failure,
          modelResponseEvents: () => events(),
        });
        assert.equal((await fixture.worker().wake()).kind, "failed");
        assert.equal(
          fixture.requests.length,
          failure.startsWith("begin") ? 0 : 1,
        );
        const calls = await fixture.callRecords();
        assert.equal(calls.length, failure === "beginBeforeCommit" ? 0 : 1);
        if (calls.length)
          assert.equal(
            calls[0]?.record.observation.outcome,
            failure === "finishAfterCommit" ? "completed" : "unknown",
          );
        await fixture.reopen();
        const report = await fixture.accountingReport();
        assert.equal(report.total.calls.intents, calls.length);
        assert.equal(report.total.usage.usageReports, failure.startsWith("finish") ? 1 : 0);
        assert.equal(report.total.calls.directUsage, failure.startsWith("finish") ? 1 : 0);
        assert.equal(report.total.calls.unfinishedWithUsage, failure === "finishBeforeCommit" ? 1 : 0);
        assert.equal((await fixture.worker().wake()).kind, "idle");
        assert.equal(
          fixture.requests.length,
          failure.startsWith("begin") ? 0 : 1,
        );
      },
    );
  }
  test(
    `${backend}: recovery by GET remains a retrieval with one deduplicated usage report`,
    options,
    async (context) => {
      const fixture = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        streamMaxRetries: 2,
        modelResponseEvents: () => events(),
        retrievedResponse: response,
        usagePersistenceFailure: "afterCommit",
      });
      assert.equal((await fixture.worker().wake()).kind, "retried");
      await fixture.reopen();
      assert.equal((await fixture.worker().wake()).kind, "completed");
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.retrievals(), 1);
      const calls = await fixture.callRecords();
      assert.deepEqual(
        calls.map((row) => row.record.observation.operation),
        ["generate", "retrieve"],
      );
      assert(
        calls.every(
          (row) => row.record.observation.providerResponseId === response.id,
        ),
      );
      assert.equal((await fixture.usageRecords()).length, 1);
      const beforeHistory = await fixture.history();
      const report = await fixture.accountingReport();
      assert.equal(report.generations.directUsage, 1);
      assert.equal(report.retrievals.responseUsage, 1);
      assert.equal(report.total.usage.inputTokens, 100);
      assert.deepEqual(await fixture.history(), beforeHistory);
    },
  );
  test(
    `${backend}: compaction clipping attempts are separate provider calls`,
    options,
    async (context) => {
      const fixture = await createFixture(context, {
        backend,
        storeResponses: false,
        crashAfterCommit: false,
        manualCompaction: true,
        initialMessages: [
          { role: "user", content: "old" },
          { role: "user", content: "recent" },
        ],
        modelResponseEvents: (n) =>
          n === 1
            ? events({
                id: "compaction-failed",
                status: "failed",
                error: { code: "context_length_exceeded" },
              })
            : events(),
      });
      assert.equal((await fixture.worker().wake()).kind, "completed");
      const calls = await fixture.callRecords();
      assert.equal(calls.length, 2);
      assert(
        calls.every((row) => row.record.observation.purpose === "compaction"),
      );
      assert.equal((await fixture.usageRecords()).length, 1);
      const report = await fixture.accountingReport();
      assert.equal(report.compaction.calls.intents, 2);
      assert.equal(report.compaction.calls.persistedUsageCoverage, 0.5);
      assert.equal(report.compaction.usage.inputTokens, 100);
    },
  );
}
