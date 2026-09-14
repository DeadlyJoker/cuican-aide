import assert from "node:assert/strict";
import test from "node:test";

import {
  reportModelCacheUsage,
  type PersistedModelUsageEvent,
} from "./model-usage-report.ts";

function usage(
  sequence: number,
  inputTokens: number,
  cachedInputTokens: number,
  reported?: boolean,
  type: "usage.recorded" | "context.compacted" = "usage.recorded",
): PersistedModelUsageEvent {
  return {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: "run-1" },
    eventId: `event-${sequence}`,
    sequence,
    occurredAt: "2026-09-10T00:00:00Z",
    type,
    data: {
      segmentId: "segment-1",
      segmentSequence: sequence,
      inputTokens,
      cachedInputTokens,
      ...(reported === undefined
        ? {}
        : { cachedInputTokensReported: reported }),
      outputTokens: 0,
      totalTokens: inputTokens,
      ...(type === "context.compacted"
        ? {
            stepId: "compact",
            compactionItemId: "history-1",
            mode: "auto",
            replacesThroughSequence: 1,
          }
        : {}),
    },
  } as PersistedModelUsageEvent;
}

test("weights cache reads by reported input and keeps unknown and compaction coverage visible", () => {
  const report = reportModelCacheUsage("run-1", [
    usage(1, 100, 0, true),
    usage(2, 900, 900, true),
    usage(3, 1000, 0, false),
    usage(4, 1000, 700),
    usage(5, 1000, 500, true, "context.compacted"),
  ]);
  assert.equal(report.sampling.cacheReadHitRate, 0.9);
  assert.equal(report.total.cacheReadHitRate, 0.7);
  assert.equal(report.total.cacheReadInputCoverage, 0.5);
  assert.equal(report.total.cacheReadReportCoverage, 0.6);
  assert.equal(report.total.cacheReadUnreportedUsageReports, 1);
  assert.equal(report.total.cacheReadLegacyUsageReports, 1);
  assert.equal(report.compaction.reportedCachedInputTokens, 500);
  assert.equal(report.scope, "persistedUsageReports");
});

test("reports zero-input and missing-cache denominators as unavailable", () => {
  assert.equal(reportModelCacheUsage("run-1", []).total.cacheReadHitRate, null);
  const empty = reportModelCacheUsage("run-1", [usage(1, 0, 0, true)]).total;
  assert.equal(empty.cacheReadHitRate, null);
  assert.equal(empty.cacheReadInputCoverage, null);
  assert.equal(empty.cacheReadReportCoverage, 1);
  assert.equal(
    reportModelCacheUsage("run-1", [usage(1, 100, 0, false)]).total
      .cacheReadHitRate,
    null,
  );
});

test("rejects duplicates, cross-run records, invalid reporting and counter overflow", () => {
  assert.throws(
    () =>
      reportModelCacheUsage("run-1", [
        usage(1, 100, null as unknown as number, true),
      ]),
    /cache_reporting_invalid/,
  );
  assert.throws(
    () => reportModelCacheUsage("run-1", [usage(1, 1, 0), usage(1, 1, 0)]),
    /event_order_invalid/,
  );
  assert.throws(
    () => reportModelCacheUsage("other-run", [usage(1, 1, 0)]),
    /event_order_invalid/,
  );
  assert.throws(
    () => reportModelCacheUsage("run-1", [usage(1, 100, 10, false)]),
    /cache_reporting_invalid/,
  );
  assert.throws(
    () => reportModelCacheUsage("run-1", [usage(1, 100, 101, true)]),
    /tokens_invalid/,
  );
  assert.throws(
    () =>
      reportModelCacheUsage("run-1", [
        usage(1, Number.MAX_SAFE_INTEGER, 0, true),
        usage(2, 1, 0, true),
      ]),
    /overflow/,
  );
});

test("consumes a long event iterator once without retaining history or per-event identifiers", () => {
  let consumed = 0;
  function* events() {
    for (let sequence = 1; sequence <= 100_000; sequence += 1) {
      consumed += 1;
      yield usage(sequence, 100, 80, true);
    }
  }
  const report = reportModelCacheUsage("run-1", events());
  assert.equal(consumed, 100_000);
  assert.equal(report.total.usageReports, 100_000);
  assert.equal(report.total.cacheReadHitRate, 0.8);
  assert.ok(JSON.stringify(report).length < 2000);
});
