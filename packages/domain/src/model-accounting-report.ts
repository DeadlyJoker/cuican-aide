import {
  validateModelCallRecord,
  type ModelCallRecord,
} from "./model-call-observation.ts";
import {
  validateModelUsageRecord,
  type ModelUsageRecord,
} from "./model-usage-observation.ts";
import { createModelCacheUsageAccumulator } from "./model-usage-report.ts";

export type ModelCallUsageEvidence = Readonly<{
  call: ModelCallRecord;
  /** At most two direct matches and one response match, deduplicated by usage identity. */
  usage: readonly ModelUsageRecord[];
}>;

function sameScope(call: ModelCallRecord, usage: ModelUsageRecord): boolean {
  const a = call.observation,
    b = usage.observation;
  return (
    call.tenantId === usage.tenantId &&
    call.runId === usage.runId &&
    a.agentVersionId === b.agentVersionId &&
    a.adapterName === b.adapterName &&
    a.adapterVersion === b.adapterVersion &&
    a.modelId === b.modelId &&
    a.purpose === b.purpose
  );
}
function directMatch(call: ModelCallRecord, usage: ModelUsageRecord): boolean {
  const a = call.observation,
    b = usage.observation;
  return (
    sameScope(call, usage) &&
    a.callId === b.callId &&
    call.stepId === usage.stepId &&
    call.attemptId === usage.attemptId &&
    (a.providerResponseId === b.providerResponseId ||
      (a.outcome === "unknown" && a.providerResponseId === null))
  );
}
function responseMatch(
  call: ModelCallRecord,
  usage: ModelUsageRecord,
): boolean {
  return (
    sameScope(call, usage) &&
    call.observation.providerResponseId !== null &&
    call.observation.providerResponseId === usage.observation.providerResponseId
  );
}

/** Fixed-size aggregation. Token totals are added once from the usage ledger, never once per call. */
export function createModelAccountingReport(locator: {
  tenantId: string;
  runId: string;
}) {
  const counts = () => ({
    intents: 0,
    unfinished: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
    interrupted: 0,
    directUsage: 0,
    responseUsage: 0,
    missingUsage: 0,
    ambiguousUsage: 0,
    conflictingUsage: 0,
    cacheReportedCalls: 0,
    usageObservedButMissing: 0,
    unfinishedWithUsage: 0,
  });
  const group = () => ({
    calls: counts(),
    usage: createModelCacheUsageAccumulator(),
  });
  const total = group(),
    generations = counts(),
    retrievals = counts(),
    sampling = group(),
    compaction = group();
  const failedResponses = createModelCacheUsageAccumulator(),
    unlistedModels = group();
  const models = new Map<
    string,
    ReturnType<typeof group> & {
      adapterName: string;
      adapterVersion: string;
      modelId: string;
    }
  >();
  const usageLinks = {
    directCall: 0,
    missingCall: 0,
    legacyWithoutCallId: 0,
    conflictingCall: 0,
  };
  const modelGroup = (
    o: ModelCallRecord["observation"] | ModelUsageRecord["observation"],
  ) => {
    const identity = {
      adapterName: o.adapterName,
      adapterVersion: o.adapterVersion,
      modelId: o.modelId,
    };
    const key = JSON.stringify(Object.values(identity));
    if (!models.has(key) && models.size < 32)
      models.set(key, { ...identity, ...group() });
    return models.get(key) ?? unlistedModels;
  };
  const validateScope = (record: { tenantId: string; runId: string }) => {
    if (record.tenantId !== locator.tenantId || record.runId !== locator.runId)
      throw new Error("model_accounting_scope_invalid");
  };
  const safe = (value: Record<string, number>) => {
    if (Object.values(value).some((n) => !Number.isSafeInteger(n)))
      throw new Error("model_accounting_overflow");
  };
  function addCall({ call, usage }: ModelCallUsageEvidence) {
    validateModelCallRecord(call);
    validateScope(call);
    if (usage.length > 3) throw new Error("model_accounting_evidence_limit");
    for (const u of usage) {
      validateModelUsageRecord(u);
      validateScope(u);
    }
    const o = call.observation;
    const status =
      usage.length === 0
        ? "missingUsage"
        : usage.length > 1
          ? "ambiguousUsage"
          : directMatch(call, usage[0]!)
            ? "directUsage"
            : usage[0]!.observation.callId !== o.callId &&
                responseMatch(call, usage[0]!)
              ? "responseUsage"
              : "conflictingUsage";
    const covered = status === "directUsage" || status === "responseUsage";
    for (const c of [
      total.calls,
      o.operation === "generate" ? generations : retrievals,
      (o.purpose === "agent" ? sampling : compaction).calls,
      modelGroup(o).calls,
    ]) {
      c.intents++;
      c[o.outcome === "unknown" ? "unfinished" : o.outcome]++;
      c[status]++;
      if (covered && usage[0]!.observation.usage.cachedInputTokensReported)
        c.cacheReportedCalls++;
      if (status === "missingUsage" && o.usageEventObserved)
        c.usageObservedButMissing++;
      if (covered && o.outcome === "unknown") c.unfinishedWithUsage++;
      safe(c);
    }
  }
  function addUsage(usage: ModelUsageRecord, origin: ModelCallRecord | null) {
    validateModelUsageRecord(usage);
    validateScope(usage);
    if (origin !== null) {
      validateModelCallRecord(origin);
      validateScope(origin);
    }
    const o = usage.observation;
    const link =
      o.callId === undefined
        ? "legacyWithoutCallId"
        : origin === null
          ? "missingCall"
          : directMatch(origin, usage)
            ? "directCall"
            : "conflictingCall";
    usageLinks[link]++;
    safe(usageLinks);
    for (const g of [
      total,
      o.purpose === "agent" ? sampling : compaction,
      modelGroup(o),
    ])
      g.usage.add(o.usage);
    if (o.responseStatus !== null) failedResponses.add(o.usage);
  }
  const snapshotCounts = (c: ReturnType<typeof counts>) => ({
    ...c,
    persistedUsageCoverage:
      c.intents === 0 ? null : (c.directUsage + c.responseUsage) / c.intents,
    directUsageCoverage: c.intents === 0 ? null : c.directUsage / c.intents,
    cacheReportingCallCoverage:
      c.intents === 0 ? null : c.cacheReportedCalls / c.intents,
  });
  const snapshotGroup = (g: ReturnType<typeof group>) => ({
    calls: snapshotCounts(g.calls),
    usage: g.usage.snapshot(),
  });
  return {
    addCall,
    addUsage,
    snapshot: () => ({
      schemaVersion: "crewon.model-accounting-report.v0" as const,
      runId: locator.runId,
      scope: "instrumentedCallsAndPersistedUsage" as const,
      total: snapshotGroup(total),
      generations: snapshotCounts(generations),
      retrievals: snapshotCounts(retrievals),
      sampling: snapshotGroup(sampling),
      compaction: snapshotGroup(compaction),
      failedResponses: failedResponses.snapshot(),
      usageLinks: { ...usageLinks },
      models: [...models.values()].map((g) => ({
        adapterName: g.adapterName,
        adapterVersion: g.adapterVersion,
        modelId: g.modelId,
        ...snapshotGroup(g),
      })),
      unlistedModels: snapshotGroup(unlistedModels),
      limitations: [
        "Call coverage includes unfinished intents; it is not proof of dispatch or billing. Missing, ambiguous and conflicting evidence is not zero usage.",
        "Direct usage identifies its originating call. Response usage identifies the same response in the adapter/model/purpose/AgentVersion scope, not another billable generation; retrievals are counted separately.",
        "Token totals scan each persisted, deduplicated usage row once, including failed responses and compaction. They must not be added to canonical usage events or multiplied by calls sharing a response.",
        "Cache hit rate is token-weighted only among usage with explicit cache metadata. Call coverage, cache field coverage and cache hit rate have different denominators; unknown input tokens cannot be estimated.",
        "Only instrumented adapters and retained observations are visible. Cloud Agent internal calls, cache writes, prices and logical-goal monetary totals remain outside this report.",
        "Pages use separate short snapshots. Fixed insertion high-water marks exclude new rows, but concurrent finalization or enrichment can change later pages; this is not a transaction-consistent bill.",
      ],
    }),
  };
}
