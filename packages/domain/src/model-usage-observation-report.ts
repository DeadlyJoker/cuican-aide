import { createModelCacheUsageAccumulator } from "./model-usage-report.ts";
import {
  validateModelUsageRecord,
  type ModelUsageRecord,
} from "./model-usage-observation.ts";

export function reportModelUsageObservations(
  locator: { tenantId: string; runId: string },
  entries: Iterable<{ order: number; record: ModelUsageRecord }>,
) {
  const total = createModelCacheUsageAccumulator();
  const sampling = createModelCacheUsageAccumulator();
  const compaction = createModelCacheUsageAccumulator();
  const failedResponses = createModelCacheUsageAccumulator();
  const unlistedModels = createModelCacheUsageAccumulator();
  const models = new Map<
    string,
    {
      adapterName: string;
      adapterVersion: string;
      modelId: string;
      totals: ReturnType<typeof createModelCacheUsageAccumulator>;
    }
  >();
  let lastOrder = 0;
  let providerIdentifiedReports = 0;
  let locallyIdentifiedReports = 0;
  for (const { order, record } of entries) {
    validateModelUsageRecord(record);
    if (
      record.tenantId !== locator.tenantId ||
      record.runId !== locator.runId ||
      !Number.isSafeInteger(order) ||
      order <= lastOrder
    )
      throw new Error("model_usage_report_order_invalid");
    lastOrder = order;
    const o = record.observation;
    total.add(o.usage);
    if (o.responseStatus !== null) failedResponses.add(o.usage);
    (o.purpose === "agent" ? sampling : compaction).add(o.usage);
    if (o.providerResponseId === null) locallyIdentifiedReports += 1;
    else providerIdentifiedReports += 1;
    const key = JSON.stringify([o.adapterName, o.adapterVersion, o.modelId]);
    let group = models.get(key);
    if (group === undefined && models.size < 32) {
      group = {
        adapterName: o.adapterName,
        adapterVersion: o.adapterVersion,
        modelId: o.modelId,
        totals: createModelCacheUsageAccumulator(),
      };
      models.set(key, group);
    }
    (group?.totals ?? unlistedModels).add(o.usage);
  }
  return {
    schemaVersion: "crewon.model-usage-observation-report.v0" as const,
    runId: locator.runId,
    scope: "persistedUsageObservations" as const,
    throughOrder: lastOrder,
    providerIdentifiedReports,
    locallyIdentifiedReports,
    total: total.snapshot(),
    sampling: sampling.snapshot(),
    compaction: compaction.snapshot(),
    failedResponses: failedResponses.snapshot(),
    models: [...models.values()].map(({ totals, ...identity }) => ({
      ...identity,
      usage: totals.snapshot(),
    })),
    unlistedModels: unlistedModels.snapshot(),
    limitations: [
      "Includes reported usage from failed/retried sampling and compaction only after this ledger was enabled; absent reports and older calls are unknown, not zero.",
      "Provider response identities deduplicate recovery within a Run and adapter/model/purpose/AgentVersion scope; observations without response identities cannot prove cross-recovery deduplication.",
      "Cloud Agent reports may aggregate internal model calls; this is not an inventory of every physical model request.",
      "Cache write usage, monetary prices and logical-goal charges are not measured; do not add this ledger to canonical usage events, which may describe the same calls.",
    ],
  };
}
