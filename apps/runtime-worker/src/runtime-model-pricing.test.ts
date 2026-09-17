import assert from "node:assert/strict";
import test from "node:test";
import type { DomainStore } from "@crewon/application";
import {
  reportModelUsageObservations,
  type ModelTokenPrice,
} from "@crewon/domain";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";
const price: ModelTokenPrice = {
  schemaVersion: "crewon.model-token-price.v0",
  currency: "USD",
  rates: { input: "2500000", cacheRead: "250000", output: "10000000" },
};
const next: ModelTokenPrice = {
  ...price,
  rates: { input: "5000000", cacheRead: "500000", output: "20000000" },
};
for (const backend of ["sqlite", "postgres"] as const)
  for (const mode of ["retry", "retrieve", "compaction"] as const)
    test(
      `${backend}: real HTTP ${mode} uses original pricing without changing model requests`,
      {
        skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
        timeout: 15000,
      },
      async (t) => {
        let f!: Awaited<ReturnType<typeof createFixture>>,
          changed = false;
        let checkpointed!: () => void;
        const checkpoint = new Promise<void>((resolve) => {
          checkpointed = resolve;
        });
        const change = async () => {
          if (changed) return;
          changed = true;
          await f.store().modelPricing!.set({
            tenantId: f.fixtureScope.actor.tenantId,
            agentVersionId: f.fixtureScope.route.agentVersionId,
            expectedRevision: 1,
            price: next,
          });
        };
        const response = (n: number, failed: boolean) => ({
          id: `response-${n}`,
          status: failed ? "failed" : "completed",
          ...(failed ? { error: { code: "server_error" } } : {}),
          output: failed
            ? []
            : [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "summary" }],
                },
              ],
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 80 },
            output_tokens: 10,
            total_tokens: 110,
          },
        });
        f = await createFixture(t, {
          backend,
          storeResponses: mode === "retrieve",
          crashAfterCommit: false,
          streamMaxRetries: 1,
          maxOutputTokens: 128,
          manualCompaction: mode === "compaction",
          ...(mode === "retrieve"
            ? {
                interruptFirstStreamAfterEvents: 2,
                beforeFirstStreamInterrupted: () => checkpoint,
                afterProviderResponseCheckpointed: async () => checkpointed(),
                retrievedResponse: response(1, false),
              }
            : {}),
          beforeUsageRecorded: async () => {
            if (mode === "retry") await change();
          },
          decorateStore: (store) =>
            new Proxy(store, {
              get(target, key) {
                if (key === "recordModelCall")
                  return async (
                    input: Parameters<DomainStore["recordModelCall"]>[0],
                  ) => {
                    const result = await target.recordModelCall(input);
                    if (
                      mode === "retrieve" &&
                      input.record.observation.operation === "retrieve"
                    )
                      await change();
                    return result;
                  };
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          modelResponseEvents: (n) => {
            const failed = mode === "retry" && n === 1;
            return [
              {
                type: "response.created",
                sequence_number: 0,
                response: { id: `response-${n}` },
              },
              ...(failed
                ? []
                : [
                    {
                      type: "response.output_text.delta",
                      sequence_number: 1,
                      delta: "summary",
                    },
                  ]),
              {
                type: failed ? "response.failed" : "response.completed",
                sequence_number: failed ? 1 : 2,
                response: response(n, failed),
              },
            ];
          },
        });
        await f.store().modelPricing!.set({
          tenantId: f.fixtureScope.actor.tenantId,
          agentVersionId: f.fixtureScope.route.agentVersionId,
          expectedRevision: 0,
          price,
        });
        const outcome = await f.worker().wake();
        assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
        const calls = await f.callRecords(),
          usage = await f.usageRecords();
        assert.equal(usage.length, mode === "retry" ? 2 : 1);
        assert.deepEqual(usage[0]!.record.generation?.tokenPricing, {
          revision: 1,
          price,
        });
        if (mode === "retry") {
          assert.deepEqual(usage[1]!.record.generation?.tokenPricing, {
            revision: 2,
            price: next,
          });
          assert.deepEqual(f.requests[1], f.requests[0]);
        }
        for (const body of f.requests)
          assert.ok(
            !JSON.stringify(body).match(/tokenPricing|rates|currency|pricing/),
          );
        const totals = reportModelUsageObservations(
          usage[0]!.record,
          usage,
        ).tokenCost;
        assert.equal(
          totals.currencies[0]!.upperPicounits,
          mode === "retry" ? "510000000" : "170000000",
        );
        if (mode === "compaction")
          assert.equal(
            totals.currencies[0]!.compaction.upperPicounits,
            "170000000",
          );
        assert.equal(f.retrievals(), mode === "retrieve" ? 1 : 0);
        const count = f.requests.length;
        await f.reopen();
        await f.worker().wake();
        assert.equal(f.requests.length, count);
        assert.deepEqual(await f.callRecords(), calls);
        assert.deepEqual(await f.usageRecords(), usage);
      },
    );
