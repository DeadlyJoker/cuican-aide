import {
  validateModelCallRecord,
  type ModelCallRecord,
} from "./model-call-observation.ts";

/** Intent and transport outcomes; never assumes absent usage is free. */
export function reportModelCalls(
  locator: { tenantId: string; runId: string },
  entries: Iterable<{ order: number; record: ModelCallRecord }>,
) {
  const empty = () => ({
    intents: 0,
    unfinished: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
    interrupted: 0,
    withResponseIdentity: 0,
    firstOutputSamples: 0,
    firstOutputLatencyTotalMs: 0,
    withUsageEvent: 0,
    withoutUsageEvent: 0,
    usageEventUnknown: 0,
  });
  const generations = empty(),
    retrievals = empty(),
    compaction = empty(),
    unlistedModels = empty();
  const models = new Map<
    string,
    {
      adapterName: string;
      adapterVersion: string;
      modelId: string;
      calls: ReturnType<typeof empty>;
    }
  >();
  const transports = { http: empty(), websocket: empty(), cloudAgent: empty() };
  let throughOrder = 0;
  function add(totals: ReturnType<typeof empty>, record: ModelCallRecord) {
    const o = record.observation;
    totals.intents++;
    if (o.outcome === "unknown") totals.usageEventUnknown++;
    else if (o.usageEventObserved) totals.withUsageEvent++;
    else totals.withoutUsageEvent++;
    if (o.outcome === "unknown") totals.unfinished++;
    else totals[o.outcome]++;
    if (o.providerResponseId !== null) totals.withResponseIdentity++;
    if (o.firstOutputLatencyMs !== null) {
      totals.firstOutputSamples++;
      totals.firstOutputLatencyTotalMs += o.firstOutputLatencyMs;
    }
    if (Object.values(totals).some((value) => !Number.isSafeInteger(value)))
      throw new Error("model_call_report_overflow");
  }
  for (const { order, record } of entries) {
    validateModelCallRecord(record);
    if (
      record.tenantId !== locator.tenantId ||
      record.runId !== locator.runId ||
      !Number.isSafeInteger(order) ||
      order <= throughOrder
    )
      throw new Error("model_call_report_order_invalid");
    throughOrder = order;
    const o = record.observation;
    add(o.operation === "generate" ? generations : retrievals, record);
    add(transports[o.transport], record);
    if (o.purpose === "compaction") add(compaction, record);
    const key = JSON.stringify([o.adapterName, o.adapterVersion, o.modelId]);
    if (!models.has(key) && models.size < 32)
      models.set(key, {
        adapterName: o.adapterName,
        adapterVersion: o.adapterVersion,
        modelId: o.modelId,
        calls: empty(),
      });
    add(models.get(key)?.calls ?? unlistedModels, record);
  }
  return {
    schemaVersion: "crewon.model-call-report.v0" as const,
    runId: locator.runId,
    throughOrder,
    generations,
    retrievals,
    compaction,
    transports,
    models: [...models.values()],
    unlistedModels,
    limitations: [
      "Intents are committed before adapter I/O. An unfinished record may have been sent or may precede dispatch; it is not evidence of zero cost.",
      "Retrieval reads an existing response and is separate from generation. Cloud Agent requests may include multiple internal model calls that this ledger cannot enumerate.",
      "Completion does not imply usage was reported or persisted. Use the usage-observation report separately; do not add its tokens to canonical usage events.",
      "Only instrumented adapters after this ledger was enabled are covered. Cache writes, prices, monetary totals and historical calls are not inferred.",
      "First-output latency starts before accounting admission and includes that wait; it is not isolated Provider compute time.",
    ],
  };
}
