import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";

function response(number: number, kind: "empty" | "continuing" | "final") {
  return {
    id: `response-${number}`,
    status: "completed",
    end_turn: kind === "final",
    output:
      kind === "empty"
        ? []
        : [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: kind }],
            },
          ],
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 80 },
      output_tokens: kind === "empty" ? 0 : 10,
      total_tokens: kind === "empty" ? 100 : 110,
    },
  };
}
function events(number: number, kind: "empty" | "continuing" | "final") {
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: `response-${number}` },
    },
    ...(kind === "empty"
      ? []
      : [
          {
            type: "response.output_text.delta",
            sequence_number: 1,
            delta: kind,
          },
          {
            type: "response.output_item.done",
            sequence_number: 2,
            output_index: 0,
            item: response(number, kind).output[0],
          },
        ]),
    {
      type: "response.completed",
      sequence_number: kind === "empty" ? 1 : 3,
      response: response(number, kind),
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
    test(
      `${backend}: empty stored=${storeResponses} response continues from a distinct durable Attempt`,
      options,
      async (context) => {
        const f = await createFixture(context, {
          backend,
          storeResponses,
          crashAfterCommit: false,
          modelResponseEvents: (n) => events(n, n === 1 ? "empty" : "final"),
        });
        assert.equal((await f.worker().wake()).kind, "completed");
        assert.equal(f.requests.length, 2);
        assert.equal(f.executions(), 0);
        const requestConfiguration = (request: Record<string, unknown>) =>
          Object.fromEntries(
            Object.entries(request).filter(
              ([key]) => key !== "input" && key !== "previous_response_id",
            ),
          );
        assert.deepEqual(
          requestConfiguration(f.requests[1]!),
          requestConfiguration(f.requests[0]!),
        );
        const history = await f.history();
        assert.equal(history.length, 2);
        assert(
          history.every(
            (item) => item.type !== "message" || item.content.length > 0,
          ),
        );
        const marker = (await f.events()).find(
          (event) => event.type === "segment.provider_continuation",
        );
        assert.equal(marker?.type, "segment.provider_continuation");
        if (marker?.type !== "segment.provider_continuation") assert.fail();
        assert.ok(marker.data.emptyContinuation);
        const calls = await f.callRecords();
        assert.equal(calls.length, 2);
        assert.notEqual(calls[0]!.record.attemptId, calls[1]!.record.attemptId);
        assert.equal(
          calls[0]!.record.attemptId,
          marker.data.emptyContinuation!.attemptId,
        );
        if (storeResponses) {
          assert.equal(f.requests[1]!.previous_response_id, "response-1");
          assert.deepEqual(f.requests[1]!.input, []);
        } else assert.deepEqual(f.requests[1], f.requests[0]);
        assert(!JSON.stringify(f.requests).includes("emptyContinuation"));
        assert.equal((await f.accountingReport()).total.usage.inputTokens, 200);
        assert.equal(
          (await f.accountingReport()).total.usage.cacheReadHitRate,
          0.8,
        );
        await f.reopen();
        await f.makeDue();
        assert.equal((await f.worker().wake()).kind, "idle");
        assert.deepEqual(await f.history(), history);
        assert.deepEqual(await f.callRecords(), calls);
      },
    );

    test(
      `${backend}: empty stored=${storeResponses} continuation survives a lost commit acknowledgement`,
      options,
      async (context) => {
        let fail = true;
        const f = await createFixture(context, {
          backend,
          storeResponses,
          crashAfterCommit: false,
          afterAssistantSampleCommitted: async () => {
            if (fail) {
              fail = false;
              throw new Error("empty_boundary_ack_lost");
            }
          },
          modelResponseEvents: (n) => events(n, n === 1 ? "empty" : "final"),
        });
        const before = await f.history();
        assert.equal((await f.worker().wake()).kind, "retried");
        assert.equal(f.requests.length, 1);
        assert.deepEqual(await f.history(), before);
        await f.reopen();
        await f.makeDue();
        const result = await f.worker().wake();
        assert.equal(result.kind, "completed", JSON.stringify(result));
        assert.equal(f.requests.length, 2);
        assert.equal(f.retrievals(), 0);
        if (storeResponses) {
          assert.equal(f.requests[1]!.previous_response_id, "response-1");
          assert.deepEqual(f.requests[1]!.input, []);
        } else assert.deepEqual(f.requests[1], f.requests[0]);
        assert.equal((await f.usageRecords()).length, 2);
        assert.equal((await f.accountingReport()).total.usage.inputTokens, 200);
        assert.equal(
          (await f.events()).filter(
            (event) => event.type === "segment.provider_continuation",
          ).length,
          1,
        );
      },
    );

    test(
      `${backend}: empty stored=${storeResponses} budget survives a restart after every committed response`,
      options,
      async (context) => {
        const f = await createFixture(context, {
          backend,
          storeResponses,
          crashAfterCommit: false,
          afterAssistantSampleCommitted: async () => {
            throw new Error("restart_after_empty_boundary");
          },
          modelResponseEvents: (n) => events(n, n <= 10 ? "empty" : "final"),
        });
        const before = await f.history();
        for (let n = 1; n <= 4; n++) {
          assert.equal((await f.worker().wake()).kind, "retried");
          assert.equal(f.requests.length, n);
          if (storeResponses && n > 1) {
            assert.equal(
              f.requests[n - 1]!.previous_response_id,
              `response-${n - 1}`,
            );
            assert.deepEqual(f.requests[n - 1]!.input, []);
          }
          await f.reopen();
          await f.makeDue();
        }
        const result = await f.worker().wake();
        assert.equal(result.kind, "failed", JSON.stringify(result));
        assert.equal(
          "code" in result && result.code,
          "model_empty_continuation_limit_exceeded",
        );
        assert.equal(f.requests.length, 4);
        assert.deepEqual(await f.history(), before);
        assert.equal((await f.accountingReport()).total.usage.inputTokens, 400);
        assert.equal((await f.accountingReport()).generations.missingUsage, 0);
        await f.reopen();
        await f.makeDue();
        assert.equal((await f.worker().wake()).kind, "idle");
        assert.equal(f.requests.length, 4);
      },
    );
  }

  test(
    `${backend}: a final answer after three empty responses remains allowed`,
    options,
    async (context) => {
      const f = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        modelResponseEvents: (n) => events(n, n <= 3 ? "empty" : "final"),
      });
      const result = await f.worker().wake();
      assert.equal(result.kind, "completed", JSON.stringify(result));
      assert.equal(f.requests.length, 4);
      assert.equal(f.requests[3]!.previous_response_id, "response-3");
      assert.deepEqual(f.requests[3]!.input, []);
      assert.equal((await f.history()).length, 2);
    },
  );

  test(
    `${backend}: an unavailable empty response checkpoint falls back to the unchanged canonical input`,
    options,
    async (context) => {
      const f = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        rejectPreviousResponseId: "response-1",
        modelResponseEvents: (n) => events(n, n === 1 ? "empty" : "final"),
      });
      const result = await f.worker().wake();
      assert.equal(result.kind, "completed", JSON.stringify(result));
      assert.equal(f.requests.length, 3);
      assert.equal(f.requests[1]!.previous_response_id, "response-1");
      assert.deepEqual(f.requests[2], f.requests[0]);
      assert.equal((await f.history()).length, 2);
      assert.equal((await f.accountingReport()).total.usage.inputTokens, 200);
    },
  );

  test(
    `${backend}: response retrieval repairs a pre-commit empty boundary failure without regenerating it`,
    options,
    async (context) => {
      let fail = true;
      const f = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        beforeAssistantSampleCommitted: async () => {
          if (fail) {
            fail = false;
            throw new Error("before_empty_boundary_commit");
          }
        },
        retrievedResponse: response(1, "empty"),
        modelResponseEvents: (n) => events(n, n === 1 ? "empty" : "final"),
      });
      const before = await f.history();
      assert.equal((await f.worker().wake()).kind, "retried");
      assert.equal(f.requests.length, 1);
      assert.deepEqual(await f.history(), before);
      await f.reopen();
      await f.makeDue();
      const result = await f.worker().wake();
      assert.equal(result.kind, "completed", JSON.stringify(result));
      assert.equal(f.requests.length, 2);
      assert.equal(f.retrievals(), 1);
      assert.equal(f.requests[1]!.previous_response_id, "response-1");
      assert.deepEqual(f.requests[1]!.input, []);
      assert.deepEqual(
        (await f.callRecords()).map(
          (entry) => entry.record.observation.operation,
        ),
        ["generate", "retrieve", "generate"],
      );
      assert.equal((await f.accountingReport()).total.usage.inputTokens, 200);
      assert.equal(
        (await f.accountingReport()).total.usage.cacheReadHitRate,
        0.8,
      );
      assert.equal((await f.accountingReport()).generations.missingUsage, 0);
    },
  );

  test(
    `${backend}: assistant-only continuation budget persists across a midpoint restart`,
    options,
    async (context) => {
      let samples = 0;
      const f = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        afterAssistantSampleCommitted: async () => {
          if (++samples === 16) throw new Error("restart_halfway");
        },
        modelResponseEvents: (n) => events(n, n < 40 ? "continuing" : "final"),
      });
      // Fair scheduling may yield before the injected crash at response 16.
      const wakePastSchedulingYield = async () => {
        for (let wake = 0; wake < 8; wake++) {
          const outcome = await f.worker().wake();
          if (outcome.kind !== "retried") return outcome;
          if (outcome.code === "run_store_busy") await delay(250);
          else if (outcome.code !== "run_execution_yield") return outcome;
          await f.makeDue();
        }
        throw new Error("fixture_scheduling_did_not_converge");
      };
      const first = await wakePastSchedulingYield();
      assert.equal(first.kind, "retried", JSON.stringify(first));
      assert.equal(
        "code" in first && first.code,
        "restart_halfway",
        JSON.stringify(first),
      );
      assert.equal(f.requests.length, 16);
      await f.reopen();
      await f.makeDue();
      const result = await wakePastSchedulingYield();
      assert.equal(result.kind, "failed", JSON.stringify(result));
      assert.equal(
        "code" in result && result.code,
        "model_provider_continuation_limit_exceeded",
      );
      assert.equal(f.requests.length, 33);
      for (let n = 1; n < f.requests.length; n++) {
        assert.equal(f.requests[n]!.previous_response_id, `response-${n}`);
        assert.deepEqual(f.requests[n]!.input, []);
      }
      assert.equal((await f.history()).length, 34);
      assert.equal((await f.accountingReport()).total.usage.inputTokens, 3300);
      assert.equal((await f.accountingReport()).generations.missingUsage, 0);
    },
  );

  test(
    `${backend}: cancellation at an empty response boundary prevents further generation`,
    options,
    async (context) => {
      const f = await createFixture(context, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        beforeAssistantSampleCommitted: async (): Promise<void> => {
          await f.cancel();
        },
        modelResponseEvents: (n) => events(n, "empty"),
      });
      const result = await f.worker().wake();
      assert.equal(result.kind, "canceled", JSON.stringify(result));
      assert.equal(f.requests.length, 1);
      assert.equal((await f.run())?.status, "canceled");
      assert.equal((await f.accountingReport()).total.usage.inputTokens, 100);
      await f.reopen();
      await f.makeDue();
      assert.equal((await f.worker().wake()).kind, "idle");
      assert.equal(f.requests.length, 1);
    },
  );
}
