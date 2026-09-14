import assert from "node:assert/strict";
import test from "node:test";
import { reportModelUsageObservations } from "./model-usage-observation-report.ts";
import type { ModelUsageRecord } from "./model-usage-observation.ts";

const locator = { tenantId: "tenant-1", runId: "run-1" };
function entry(
  order: number,
  inputTokens = 100,
  cachedInputTokens = 80,
  reported = true,
) {
  const record: ModelUsageRecord = {
    ...locator,
    stepId: "step-1",
    attemptId: "attempt-1",
    observedAt: "2026-08-08T00:00:00Z",
    observation: {
      schemaVersion: "crewon.model-usage-observation.v0",
      observationId: `observation-${order}`,
      providerResponseId: `response-${order}`,
      responseStatus: null,
      purpose: "agent",
      agentVersionId: "agent-1",
      adapterName: "adapter",
      adapterVersion: "1",
      modelId: "model",
      usage: {
        inputTokens,
        cachedInputTokens,
        cachedInputTokensReported: reported,
        outputTokens: 0,
        totalTokens: inputTokens,
      },
    },
  };
  return { order, record };
}

test("usage observations report weighted cache reads, failed calls, compaction and missing metadata separately", () => {
  const failed = entry(1, 100, 0);
  failed.record = {
    ...failed.record,
    observation: {
      ...failed.record.observation,
      responseStatus: "failed",
      purpose: "compaction",
    },
  };
  const missing = entry(3, 1000, 0, false);
  missing.record = {
    ...missing.record,
    observation: { ...missing.record.observation, providerResponseId: null },
  };
  const report = reportModelUsageObservations(locator, [
    failed,
    entry(2),
    missing,
  ]);
  assert.equal(report.total.cacheReadHitRate, 0.4);
  assert.equal(report.total.cacheReadInputCoverage, 1 / 6);
  assert.equal(report.total.cacheReadReportCoverage, 2 / 3);
  assert.equal(report.compaction.usageReports, 1);
  assert.equal(report.sampling.usageReports, 2);
  assert.equal(report.failedResponses.usageReports, 1);
  assert.equal(report.providerIdentifiedReports, 2);
  assert.equal(report.locallyIdentifiedReports, 1);
  assert.equal(report.models.length, 1);
  assert.match(report.limitations.join(" "), /unknown, not zero/);
  assert.equal(
    reportModelUsageObservations(locator, []).total.cacheReadHitRate,
    null,
  );
  assert.equal(
    reportModelUsageObservations(locator, [entry(1, 0, 0)]).total
      .cacheReadHitRate,
    null,
  );
});

test("usage observation reports reject mixed identities, repeated order, invalid data and overflow", () => {
  assert.throws(
    () => reportModelUsageObservations(locator, [entry(2), entry(1)]),
    /order_invalid/,
  );
  assert.throws(
    () =>
      reportModelUsageObservations({ ...locator, tenantId: "other-tenant" }, [
        entry(1),
      ]),
    /order_invalid/,
  );
  assert.throws(
    () => reportModelUsageObservations(locator, [entry(1, 100, 101)]),
    /tokens_invalid/,
  );
  assert.throws(
    () => reportModelUsageObservations(locator, [entry(1, 100, 80, false)]),
    /tokens_invalid/,
  );
  assert.throws(
    () =>
      reportModelUsageObservations(locator, [
        entry(1, Number.MAX_SAFE_INTEGER, 0),
        entry(2, 1, 0),
      ]),
    /overflow/,
  );
});

test("100,000 usage observations keep only 32 named model groups and account for every remaining report", () => {
  function* entries() {
    for (let order = 1; order <= 100_000; order += 1) {
      const value = entry(order, 10, 5);
      yield {
        ...value,
        record: {
          ...value.record,
          observation: {
            ...value.record.observation,
            modelId: `model-${order}`,
          },
        },
      };
    }
  }
  const report = reportModelUsageObservations(locator, entries());
  assert.equal(report.models.length, 32);
  assert.equal(report.total.usageReports, 100_000);
  assert.equal(report.unlistedModels.usageReports, 99_968);
  assert.equal(report.total.cacheReadHitRate, 0.5);
  assert.ok(JSON.stringify(report).length < 32 * 1024);
});
