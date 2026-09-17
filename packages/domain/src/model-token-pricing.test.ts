import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateModelTokenCost,
  validateModelTokenPrice,
  type ModelTokenPricingSnapshot,
} from "./model-token-pricing.ts";
import { createModelTokenCostAccumulator } from "./model-token-cost-report.ts";
import type { ModelUsageRecord } from "./model-usage-observation.ts";
const pricing: ModelTokenPricingSnapshot = {
  revision: 1,
  price: {
    schemaVersion: "crewon.model-token-price.v0",
    currency: "USD",
    rates: { input: "2500000", cacheRead: "250000", output: "10000000" },
  },
};
const usage = {
  inputTokens: 100,
  cachedInputTokens: 80,
  cachedInputTokensReported: true,
  outputTokens: 10,
};
test("charges disjoint uncached input, cache reads and total output once using exact integers", () => {
  assert.deepEqual(estimateModelTokenCost(pricing, usage), {
    currency: "USD",
    lowerPicounits: "170000000",
    upperPicounits: "170000000",
    exactForConfiguredRates: true,
  });
  assert.equal(
    estimateModelTokenCost(pricing, { ...usage, cachedInputTokens: 0 })
      .upperPicounits,
    "350000000",
  );
});
test("unknown cache use produces conservative bounds, including expensive cache reads", () => {
  assert.deepEqual(
    estimateModelTokenCost(pricing, {
      ...usage,
      cachedInputTokens: 0,
      cachedInputTokensReported: false,
    }),
    {
      currency: "USD",
      lowerPicounits: "125000000",
      upperPicounits: "350000000",
      exactForConfiguredRates: false,
    },
  );
  const reverse = {
    ...pricing,
    price: {
      ...pricing.price,
      rates: { ...pricing.price.rates, input: "250000", cacheRead: "2500000" },
    },
  };
  assert.equal(
    estimateModelTokenCost(reverse, {
      ...usage,
      cachedInputTokens: 0,
      cachedInputTokensReported: false,
    }).upperPicounits,
    "350000000",
  );
});
test("zero input or equal rates do not require a guessed cache report", () => {
  assert.equal(
    estimateModelTokenCost(pricing, {
      ...usage,
      inputTokens: 0,
      cachedInputTokens: 0,
      cachedInputTokensReported: false,
    }).exactForConfiguredRates,
    true,
  );
  const same = {
    ...pricing,
    price: {
      ...pricing.price,
      rates: { ...pricing.price.rates, cacheRead: pricing.price.rates.input },
    },
  };
  assert.equal(
    estimateModelTokenCost(same, {
      ...usage,
      cachedInputTokens: 0,
      cachedInputTokensReported: false,
    }).exactForConfiguredRates,
    true,
  );
});
test("large token counts and tiny prices never pass through floating point money", () => {
  const p = {
    ...pricing,
    price: {
      ...pricing.price,
      rates: { input: "1", cacheRead: "1", output: "999999999999999999" },
    },
  };
  const n = Number.MAX_SAFE_INTEGER;
  const cost = estimateModelTokenCost(p, {
    inputTokens: n,
    cachedInputTokens: 0,
    cachedInputTokensReported: true,
    outputTokens: n,
  });
  assert.equal(
    cost.upperPicounits,
    (BigInt(n) * 1000000000000000000n).toString(),
  );
});
test("prices and usage reject malformed, overlapping, fractional or hidden extra fields", () => {
  for (const rate of ["-1", "0.1", "01", "1e3", "1000000000000000000", 1, null])
    assert.throws(() =>
      validateModelTokenPrice({
        ...pricing.price,
        rates: { ...pricing.price.rates, input: rate as string },
      }),
    );
  for (const value of [
    { ...pricing.price, currency: 1 },
    { ...pricing.price, currency: "usd" },
    { ...pricing.price, extra: true },
    { ...pricing.price, rates: { ...pricing.price.rates, cacheWrite: "1" } },
  ])
    assert.throws(() => validateModelTokenPrice(value as typeof pricing.price));
  for (const u of [
    { ...usage, cachedInputTokens: 101 },
    { ...usage, cachedInputTokensReported: false },
    { ...usage, inputTokens: 1.1 },
  ])
    assert.throws(() => estimateModelTokenCost(pricing, u));
});
function record(
  currency: string | undefined,
  purpose: "agent" | "compaction" = "agent",
): ModelUsageRecord {
  return {
    tenantId: "tenant",
    runId: "run",
    stepId: "step",
    attemptId: "attempt",
    observedAt: "2026-09-15T00:00:00Z",
    ...(currency === undefined
      ? {}
      : {
          generation: {
            callId: "call",
            tokenPricing: { ...pricing, price: { ...pricing.price, currency } },
          },
        }),
    observation: {
      schemaVersion: "crewon.model-usage-observation.v0",
      observationId: "usage",
      providerResponseId: null,
      responseStatus: null,
      purpose,
      agentVersionId: "agent",
      adapterName: "adapter",
      adapterVersion: "1",
      modelId: "model",
      usage: { ...usage, totalTokens: 110 },
    },
  };
}
test("cost reporting never adds currencies, counts unknown quotes and includes compaction", () => {
  const a = createModelTokenCostAccumulator();
  a.add(record("USD"));
  a.add(record("USD", "compaction"));
  a.add(record("CNY"));
  a.add(record(undefined));
  const r = a.snapshot();
  assert.equal(r.unpricedUsageRecords, 1);
  assert.equal(r.pricedUsageRecords, 3);
  assert.equal(r.currencies.length, 2);
  assert.equal(r.currencies[0]!.upperPicounits, "340000000");
  assert.equal(r.currencies[0]!.compaction.upperPicounits, "170000000");
  assert.equal(r.currencies[1]!.upperPicounits, "170000000");
});
test("currency cardinality is bounded and overflow remains explicit", () => {
  const a = createModelTokenCostAccumulator();
  for (let i = 0; i < 26; i++)
    a.add(record(`AA${String.fromCharCode(65 + i)}`));
  const r = a.snapshot();
  assert.equal(r.currencies.length, 8);
  assert.equal(r.unlistedCurrencyRecords, 18);
  assert.equal(r.pricedUsageRecords, 26);
});

test("explicit zero rates remain a known estimate, distinct from an absent quote", () => {
  const free = {
    ...pricing,
    price: {
      ...pricing.price,
      rates: { input: "0", cacheRead: "0", output: "0" },
    },
  };
  assert.deepEqual(
    estimateModelTokenCost(free, {
      ...usage,
      cachedInputTokens: 0,
      cachedInputTokensReported: false,
    }),
    {
      currency: "USD",
      lowerPicounits: "0",
      upperPicounits: "0",
      exactForConfiguredRates: true,
    },
  );
  const accumulator = createModelTokenCostAccumulator();
  const row = record("USD");
  accumulator.add({
    ...row,
    generation: { callId: "free", tokenPricing: free },
  });
  accumulator.add(record(undefined));
  const report = accumulator.snapshot();
  assert.equal(report.pricedUsageRecords, 1);
  assert.equal(report.unpricedUsageRecords, 1);
  assert.equal(report.currencies[0]!.upperPicounits, "0");
});
