import assert from "node:assert/strict";
import test from "node:test";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const manualCompaction of [false, true]) {
    test(
      `${backend}: ${manualCompaction ? "compaction" : "agent"} output ceiling stops generation, keeps reported usage and survives restart`,
      {
        skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
        timeout: 15000,
      },
      async (t) => {
        const f = await createFixture(t, {
          backend,
          storeResponses: false,
          crashAfterCommit: false,
          streamMaxRetries: 3,
          maxOutputTokens: 128,
          manualCompaction,
          modelResponseEvents: () => [
            {
              type: "response.created",
              sequence_number: 0,
              response: { id: "limited" },
            },
            {
              type: "response.output_text.delta",
              sequence_number: 1,
              delta: "partial output",
            },
            {
              type: "response.incomplete",
              sequence_number: 2,
              response: {
                id: "limited",
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "partial output" }],
                  },
                ],
                usage: {
                  input_tokens: 100,
                  input_tokens_details: { cached_tokens: 80 },
                  output_tokens: 128,
                  total_tokens: 228,
                },
              },
            },
          ],
        });
        const outcome = await f.worker().wake();
        assert.equal(outcome.kind, "failed", JSON.stringify(outcome));
        assert.equal(
          "code" in outcome && outcome.code,
          "responses_incomplete_max_output_tokens",
        );
        assert.equal(f.requests.length, 1);
        assert.equal(f.requests[0]!.max_output_tokens, 128);
        const calls = await f.callRecords(),
          usage = await f.usageRecords();
        assert.equal(calls.length, 1);
        assert.equal(
          calls[0]!.record.observation.purpose,
          manualCompaction ? "compaction" : "agent",
        );
        assert.equal(calls[0]!.record.observation.maxOutputTokens, 128);
        assert.equal(calls[0]!.record.observation.outcome, "failed");
        assert.equal(usage.length, 1);
        assert.equal(usage[0]!.record.observation.usage.outputTokens, 128);
        assert.equal(usage[0]!.record.observation.usage.cachedInputTokens, 80);
        const history = await f.history();
        await f.reopen();
        await f.worker().wake();
        assert.equal(f.requests.length, 1);
        assert.deepEqual(await f.callRecords(), calls);
        assert.deepEqual(await f.usageRecords(), usage);
        assert.deepEqual(await f.history(), history);
      },
    );
  }
}
