import assert from "node:assert/strict";
import test from "node:test";
import { reportModelUsageObservations } from "@crewon/domain";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

function completed(id: string, cached = 80) {
  return {
    id,
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
      input_tokens_details: { cached_tokens: cached },
      output_tokens: 10,
      total_tokens: 110,
    },
  };
}
function events(response: Record<string, unknown>) {
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: response.id },
    },
    ...(response.status === "completed"
      ? [
          {
            type: "response.output_text.delta",
            sequence_number: 1,
            delta: "answer",
          },
        ]
      : []),
    {
      type: `response.${response.status}`,
      sequence_number: response.status === "completed" ? 2 : 1,
      response,
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
    `${backend}: compaction retries retain each known usage report while committing one summary`,
    options,
    async (context) => {
      const fixture = await createFixture(context, {
        backend,
        storeResponses: false,
        crashAfterCommit: false,
        manualCompaction: true,
        initialMessages: [
          { role: "user", content: "older user context" },
          { role: "user", content: "recent user context" },
        ],
        modelResponseEvents: (number) =>
          number === 1
            ? events({
                id: "compaction-failed",
                status: "failed",
                error: { code: "context_length_exceeded" },
                usage: completed("unused", 0).usage,
              })
            : events(completed("compaction-success")),
      });
      const result = await fixture.worker().wake();
      assert.equal(result.kind, "completed", JSON.stringify(result));
      const records = await fixture.usageRecords();
      const report = reportModelUsageObservations(records[0]!.record, records);
      assert.equal(report.compaction.usageReports, 2);
      assert.equal(report.compaction.inputTokens, 200);
      assert.equal(report.sampling.usageReports, 0);
      assert.equal(report.failedResponses.usageReports, 1);
      assert.equal(
        (await fixture.events()).filter(
          (event) => event.type === "context.compacted",
        ).length,
        1,
      );
      const first = fixture.requests[0]!.input as unknown[];
      const second = fixture.requests[1]!.input as unknown[];
      assert.equal(first.length - second.length, 1);
      assert.deepEqual(first.at(-1), second.at(-1));
    },
  );

  test(
    `${backend}: reported usage survives a stream error after the response terminal without committing a successful answer`,
    options,
    async (context) => {
      const fixture = await createFixture(context, {
        backend,
        storeResponses: false,
        crashAfterCommit: false,
        modelResponseEvents: () => [
          ...events(completed("response-failed-stream")),
          {
            type: "response.output_text.delta",
            sequence_number: 3,
            delta: "invalid late output",
          },
        ],
      });
      assert.equal((await fixture.worker().wake()).kind, "failed");
      assert.equal((await fixture.usageRecords()).length, 1);
      assert.equal(
        (await fixture.events()).filter(
          (event) => event.type === "usage.recorded",
        ).length,
        0,
      );
      assert.equal(
        (await fixture.history()).filter(
          (item) => item.type === "message" && item.role === "assistant",
        ).length,
        0,
      );
      await fixture.reopen();
      assert.equal(
        (await fixture.usageRecords())[0]?.record.observation.usage
          .cachedInputTokens,
        80,
      );
      assert.equal(fixture.requests.length, 1);
    },
  );

  test(
    `${backend}: failed sampling usage and successful retry are counted independently without changing the request prefix`,
    options,
    async (context) => {
      const fixture = await createFixture(context, {
        backend,
        storeResponses: false,
        crashAfterCommit: false,
        streamMaxRetries: 1,
        modelResponseEvents: (number) =>
          number === 1
            ? events({
                id: "response-failed",
                status: "failed",
                error: { code: "server_error" },
                usage: completed("unused", 0).usage,
              })
            : events(completed("response-retried")),
      });
      const outcome = await fixture.worker().wake();
      assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
      const records = await fixture.usageRecords();
      assert.equal(records.length, 2);
      const report = reportModelUsageObservations(records[0]!.record, records);
      assert.equal(report.total.inputTokens, 200);
      assert.equal(report.total.reportedCachedInputTokens, 80);
      assert.equal(report.total.cacheReadHitRate, 0.4);
      assert.equal(report.failedResponses.usageReports, 1);
      assert.equal(report.providerIdentifiedReports, 2);
      assert.equal(
        (await fixture.events()).filter(
          (event) => event.type === "usage.recorded",
        ).length,
        1,
      );
      assert.deepEqual(fixture.requests[0], fixture.requests[1]);
    },
  );

  for (const failure of ["beforeCommit", "afterCommit"] as const) {
    test(
      `${backend}: ${failure} usage persistence failure recovers by GET and records the Provider response once`,
      options,
      async (context) => {
        const response = completed("response-durable-usage");
        const fixture = await createFixture(context, {
          backend,
          storeResponses: true,
          crashAfterCommit: false,
          streamMaxRetries: 2,
          modelResponseEvents: () => events(response),
          retrievedResponse: response,
          usagePersistenceFailure: failure,
        });
        assert.equal((await fixture.worker().wake()).kind, "retried");
        assert.equal(
          fixture.requests.length,
          1,
          "the Kernel must not resample on a ledger write failure",
        );
        assert.equal(
          (await fixture.usageRecords()).length,
          failure === "beforeCommit" ? 0 : 1,
        );
        await fixture.reopen();
        const outcome = await fixture.worker().wake();
        assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
        assert.equal((await fixture.usageRecords()).length, 1);
        assert.equal(fixture.requests.length, 1);
        assert.equal(fixture.retrievals(), 1);
        assert.equal(
          (await fixture.events()).filter(
            (event) => event.type === "usage.recorded",
          ).length,
          1,
        );
      },
    );
  }

  for (const recoveryReport of ["missingCache", "conflictingTokens"] as const) {
    test(
      `${backend}: recovery ${recoveryReport} preserves known usage without repeated sampling or reconciliation`,
      options,
      async (context) => {
        const response = completed("response-recovery-metadata");
        const fixture = await createFixture(context, {
          backend,
          storeResponses: true,
          crashAfterCommit: false,
          streamMaxRetries: 2,
          modelResponseEvents: () => events(response),
          retrievedResponse: {
            ...response,
            usage:
              recoveryReport === "missingCache"
                ? { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
                : { ...response.usage, input_tokens: 101, total_tokens: 111 },
          },
          usagePersistenceFailure: "afterCommit",
        });
        assert.equal((await fixture.worker().wake()).kind, "retried");
        await fixture.reopen();
        const outcome = await fixture.worker().wake();
        if (recoveryReport === "missingCache") {
          assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
        } else {
          assert.equal(outcome.kind, "failed", JSON.stringify(outcome));
          assert.ok("code" in outcome);
          assert.equal(outcome.code, "model_usage_conflict");
        }
        assert.equal((await fixture.worker().wake()).kind, "idle");
        const records = await fixture.usageRecords();
        assert.equal(records.length, 1);
        assert.equal(records[0]?.record.observation.usage.inputTokens, 100);
        assert.equal(
          records[0]?.record.observation.usage.cachedInputTokens,
          80,
        );
        assert.equal(
          records[0]?.record.observation.usage.cachedInputTokensReported,
          true,
        );
        assert.equal(fixture.requests.length, 1);
        assert.equal(fixture.retrievals(), 1);
      },
    );
  }

  test(
    `${backend}: cancellation after usage arrived retains known consumption without reporting zero cost`,
    options,
    async (context) => {
      let cancel = async () => {};
      let canceled = false;
      const fixture = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        modelResponseEvents: () => events(completed("response-canceled")),
        beforeUsageRecorded: async () => {
          if (!canceled) {
            canceled = true;
            await cancel();
          }
        },
      });
      cancel = fixture.cancel;
      assert.equal((await fixture.worker().wake()).kind, "canceled");
      const records = await fixture.usageRecords();
      assert.equal(records.length, 1);
      assert.equal(records[0]?.record.observation.usage.totalTokens, 110);
      assert.equal(fixture.requests.length, 1);
      const calls = await fixture.callRecords();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.record.observation.outcome, "canceled");
      assert.equal(calls[0]?.record.observation.usageEventObserved, true);
      assert.equal((await fixture.run())?.status, "canceled");
      await fixture.reopen();
      assert.deepEqual(await fixture.callRecords(), calls);
      assert.equal((await fixture.worker().wake()).kind, "idle");
    },
  );
}
