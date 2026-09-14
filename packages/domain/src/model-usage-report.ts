import type { RunLifecycleEvent } from "./run-lifecycle.ts";

export function cacheReadReportingError(
  usage: Readonly<{
    cachedInputTokens?: unknown;
    cachedInputTokensReported?: unknown;
  }>,
): string | null {
  const reported = usage.cachedInputTokensReported;
  if (
    (usage.cachedInputTokens !== undefined &&
      (!Number.isSafeInteger(usage.cachedInputTokens) ||
        Number(usage.cachedInputTokens) < 0)) ||
    (reported !== undefined && typeof reported !== "boolean") ||
    (reported === true &&
      (!Number.isSafeInteger(usage.cachedInputTokens) ||
        Number(usage.cachedInputTokens) < 0)) ||
    (reported === false && (usage.cachedInputTokens ?? 0) !== 0)
  )
    return "usage_cache_reporting_invalid";
  return null;
}

export type PersistedModelUsageEvent = Extract<
  RunLifecycleEvent,
  { type: "usage.recorded" | "context.compacted" }
>;

type ReportedUsage = Pick<
  PersistedModelUsageEvent["data"],
  | "inputTokens"
  | "cachedInputTokens"
  | "cachedInputTokensReported"
  | "outputTokens"
  | "totalTokens"
>;

type UsageTotals = {
  usageReports: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadReportedUsageReports: number;
  cacheReadUnreportedUsageReports: number;
  cacheReadLegacyUsageReports: number;
  cacheReadReportedInputTokens: number;
  reportedCachedInputTokens: number;
};

/** Fixed-size accumulator shared by event diagnostics and the independent ledger. */
export function createModelCacheUsageAccumulator() {
  const total = emptyTotals();
  return {
    add(usage: ReportedUsage) {
      validateUsage(usage);
      addUsage(total, usage);
    },
    snapshot: () => statistics(total),
  };
}

export type ModelCacheUsageStatistics = Readonly<
  UsageTotals & {
    /** Token-weighted ratio among reports with explicit cache metadata. */
    cacheReadHitRate: number | null;
    /** Input token coverage among persisted usage reports, not all model calls. */
    cacheReadInputCoverage: number | null;
    cacheReadReportCoverage: number | null;
  }
>;

export type ModelCacheUsageReport = Readonly<{
  schemaVersion: "crewon.model-cache-usage-report.v0";
  runId: string;
  scope: "persistedUsageReports";
  total: ModelCacheUsageStatistics;
  sampling: ModelCacheUsageStatistics;
  compaction: ModelCacheUsageStatistics;
}>;

/** Consumes one Run's immutable, ordered usage events with a fixed-size accumulator. */
export function reportModelCacheUsage(
  runId: string,
  events: Iterable<PersistedModelUsageEvent>,
): ModelCacheUsageReport {
  const total = emptyTotals();
  const sampling = emptyTotals();
  const compaction = emptyTotals();
  let lastSequence = 0;
  for (const event of events) {
    if (
      event.schemaVersion !== "crewon.run-event.v0" ||
      event.identity.runId !== runId ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence <= lastSequence ||
      (event.type !== "usage.recorded" && event.type !== "context.compacted")
    )
      throw new Error("usage_report_event_order_invalid");
    validateUsage(event.data);
    lastSequence = event.sequence;
    addUsage(total, event.data);
    addUsage(
      event.type === "usage.recorded" ? sampling : compaction,
      event.data,
    );
  }
  return {
    schemaVersion: "crewon.model-cache-usage-report.v0",
    runId,
    scope: "persistedUsageReports",
    total: statistics(total),
    sampling: statistics(sampling),
    compaction: statistics(compaction),
  };
}

function emptyTotals(): UsageTotals {
  return {
    usageReports: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadReportedUsageReports: 0,
    cacheReadUnreportedUsageReports: 0,
    cacheReadLegacyUsageReports: 0,
    cacheReadReportedInputTokens: 0,
    reportedCachedInputTokens: 0,
  };
}

function validateUsage(usage: ReportedUsage): void {
  for (const value of [
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
    usage.cachedInputTokens ?? 0,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("usage_report_tokens_invalid");
  }
  if (
    usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
    (usage.cachedInputTokens ?? 0) > usage.inputTokens
  ) {
    throw new Error("usage_report_tokens_invalid");
  }
  const error = cacheReadReportingError(usage);
  if (error !== null) throw new Error(error);
}

function addUsage(total: UsageTotals, usage: ReportedUsage): void {
  total.usageReports += 1;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  if (usage.cachedInputTokensReported === true) {
    total.cacheReadReportedUsageReports += 1;
    total.cacheReadReportedInputTokens += usage.inputTokens;
    total.reportedCachedInputTokens += usage.cachedInputTokens!;
  } else if (usage.cachedInputTokensReported === false) {
    total.cacheReadUnreportedUsageReports += 1;
  } else {
    total.cacheReadLegacyUsageReports += 1;
  }
  if (Object.values(total).some((value) => !Number.isSafeInteger(value))) {
    throw new Error("usage_report_overflow");
  }
}

function statistics(total: UsageTotals): ModelCacheUsageStatistics {
  return {
    ...total,
    cacheReadHitRate: ratio(
      total.reportedCachedInputTokens,
      total.cacheReadReportedInputTokens,
    ),
    cacheReadInputCoverage: ratio(
      total.cacheReadReportedInputTokens,
      total.inputTokens,
    ),
    cacheReadReportCoverage: ratio(
      total.cacheReadReportedUsageReports,
      total.usageReports,
    ),
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}
