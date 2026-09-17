import { estimateModelTokenCost } from "./model-token-pricing.ts";
import type { ModelUsageRecord } from "./model-usage-observation.ts";
/** Fixed currency cardinality; request IDs/pricing revisions never become metric labels. */
export function createModelTokenCostAccumulator() {
  const currencies = new Map<
    string,
    {
      records: number;
      uncertainCacheRecords: number;
      lower: bigint;
      upper: bigint;
      samplingLower: bigint;
      samplingUpper: bigint;
      compactionLower: bigint;
      compactionUpper: bigint;
    }
  >();
  let unpricedUsageRecords = 0,
    pricedUsageRecords = 0,
    unlistedCurrencyRecords = 0;
  return {
    add(record: ModelUsageRecord) {
      const pricing = record.generation?.tokenPricing;
      if (pricing === undefined) {
        unpricedUsageRecords++;
        return;
      }
      const cost = estimateModelTokenCost(pricing, record.observation.usage);
      pricedUsageRecords++;
      let group = currencies.get(cost.currency);
      if (group === undefined) {
        if (currencies.size === 8) {
          unlistedCurrencyRecords++;
          return;
        }
        group = {
          records: 0,
          uncertainCacheRecords: 0,
          lower: 0n,
          upper: 0n,
          samplingLower: 0n,
          samplingUpper: 0n,
          compactionLower: 0n,
          compactionUpper: 0n,
        };
        currencies.set(cost.currency, group);
      }
      const lower = BigInt(cost.lowerPicounits),
        upper = BigInt(cost.upperPicounits);
      group.records++;
      if (!cost.exactForConfiguredRates) group.uncertainCacheRecords++;
      group.lower += lower;
      group.upper += upper;
      if (record.observation.purpose === "agent") {
        group.samplingLower += lower;
        group.samplingUpper += upper;
      } else {
        group.compactionLower += lower;
        group.compactionUpper += upper;
      }
      if (group.upper.toString().length > 64)
        throw new Error("model_token_cost_report_overflow");
    },
    snapshot() {
      return {
        scope: "configuredReportedTextTokenCosts" as const,
        unit: "1e-12 currency units" as const,
        pricedUsageRecords,
        unpricedUsageRecords,
        unlistedCurrencyRecords,
        currencies: [...currencies].map(([currency, g]) => ({
          currency,
          records: g.records,
          uncertainCacheRecords: g.uncertainCacheRecords,
          lowerPicounits: g.lower.toString(),
          upperPicounits: g.upper.toString(),
          sampling: {
            lowerPicounits: g.samplingLower.toString(),
            upperPicounits: g.samplingUpper.toString(),
          },
          compaction: {
            lowerPicounits: g.compactionLower.toString(),
            upperPicounits: g.compactionUpper.toString(),
          },
        })),
      };
    },
  };
}
