import assert from "node:assert/strict";
import test from "node:test";
import { createModelAccountingReport } from "./model-accounting-report.ts";
import type { ModelCallRecord } from "./model-call-observation.ts";
import type { ModelUsageRecord } from "./model-usage-observation.ts";

const locator = { tenantId: "tenant", runId: "run" };
function call(
  id: string,
  override: Partial<ModelCallRecord["observation"]> = {},
): ModelCallRecord {
  return {
    ...locator,
    stepId: "step",
    attemptId: "attempt",
    observation: {
      schemaVersion: "crewon.model-call-observation.v0",
      callId: id,
      purpose: "agent",
      agentVersionId: "agent",
      adapterName: "adapter",
      adapterVersion: "1",
      modelId: "model",
      transport: "http",
      operation: "generate",
      startedAt: "2026-09-11T00:00:00Z",
      finishedAt: "2026-09-11T00:00:01Z",
      outcome: "completed",
      providerResponseId: `response-${id}`,
      firstOutputLatencyMs: 100,
      usageEventObserved: true,
      ...override,
    },
  };
}
function usage(c: ModelCallRecord): ModelUsageRecord {
  const o = c.observation;
  return {
    ...locator,
    stepId: c.stepId,
    attemptId: c.attemptId,
    observedAt: "2026-09-11T00:00:00Z",
    observation: {
      schemaVersion: "crewon.model-usage-observation.v0",
      observationId: `usage-${o.callId}`,
      callId: o.callId,
      providerResponseId: o.providerResponseId,
      responseStatus: null,
      purpose: o.purpose,
      agentVersionId: o.agentVersionId,
      adapterName: o.adapterName,
      adapterVersion: o.adapterVersion,
      modelId: o.modelId,
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        cachedInputTokens: 80,
        cachedInputTokensReported: true,
      },
    },
  };
}

test("coverage keeps unknown attempts and missing persistence while response retrieval never multiplies token totals", () => {
  const a = call("a"),
    u = usage(a);
  const retrieval = call("get", {
    operation: "retrieve",
    providerResponseId: a.observation.providerResponseId,
  });
  const unknown = call("unknown", {
    outcome: "unknown",
    finishedAt: null,
    firstOutputLatencyMs: null,
    usageEventObserved: false,
    providerResponseId: null,
  });
  const recoveredUsage = usage(call("unknown"));
  const missing = call("failed", { outcome: "failed" });
  const compact = call("compact", { purpose: "compaction", outcome: "failed" }),
    compactUsage = usage(compact);
  const missingCache: ModelUsageRecord = {
    ...compactUsage,
    observation: {
      ...compactUsage.observation,
      responseStatus: "failed",
      usage: {
        ...compactUsage.observation.usage,
        cachedInputTokens: 0,
        cachedInputTokensReported: false,
      },
    },
  };
  const report = createModelAccountingReport(locator);
  for (const [c, evidence] of [
    [a, [u]],
    [retrieval, [u]],
    [unknown, [recoveredUsage]],
    [missing, []],
    [compact, [missingCache]],
  ] as const)
    report.addCall({ call: c, usage: evidence });
  report.addUsage(u, a);
  report.addUsage(recoveredUsage, unknown);
  report.addUsage(missingCache, compact);
  const r = report.snapshot();
  assert.equal(r.total.calls.intents, 5);
  assert.equal(r.total.calls.directUsage, 3);
  assert.equal(r.total.calls.responseUsage, 1);
  assert.equal(r.total.calls.unfinishedWithUsage, 1);
  assert.equal(r.total.calls.missingUsage, 1);
  assert.equal(r.total.calls.usageObservedButMissing, 1);
  assert.equal(r.total.calls.persistedUsageCoverage, 0.8);
  assert.equal(r.generations.persistedUsageCoverage, 0.75);
  assert.equal(r.retrievals.responseUsage, 1);
  assert.equal(r.total.usage.inputTokens, 300);
  assert.equal(r.total.usage.reportedCachedInputTokens, 160);
  assert.equal(r.total.usage.cacheReadHitRate, 0.8);
  assert.equal(r.total.usage.cacheReadInputCoverage, 2 / 3);
  assert.equal(r.failedResponses.inputTokens, 100);
  assert.equal(r.compaction.usage.inputTokens, 100);
});

test("ambiguous or conflicting identities cannot certify coverage; legacy and unmatched usage stay visible", () => {
  const c = call("a"),
    u = usage(c),
    other = usage(call("b"));
  const r = createModelAccountingReport(locator);
  r.addCall({ call: c, usage: [u, other] });
  r.addCall({
    call: call("c"),
    usage: [{ ...usage(call("c")), attemptId: "forged" }],
  });
  r.addCall({
    call: call("d"),
    usage: [
      {
        ...usage(call("d")),
        observation: { ...usage(call("d")).observation, modelId: "other" },
      },
    ],
  });
  const legacy = { ...u, observation: { ...u.observation } };
  delete legacy.observation.callId;
  r.addUsage(legacy, null);
  r.addUsage(other, null);
  r.addUsage({ ...u, attemptId: "wrong" }, c);
  const s = r.snapshot();
  assert.equal(s.total.calls.ambiguousUsage, 1);
  assert.equal(s.total.calls.conflictingUsage, 2);
  assert.equal(s.total.calls.persistedUsageCoverage, 0);
  assert.deepEqual(s.usageLinks, {
    directCall: 0,
    missingCall: 1,
    legacyWithoutCallId: 1,
    conflictingCall: 1,
  });
  assert.equal(s.total.usage.usageReports, 3);
});

test("fixed model groups overflow explicitly, and empty or invalid evidence never becomes a zero-cost guarantee", () => {
  const report = createModelAccountingReport(locator);
  assert.equal(report.snapshot().total.calls.persistedUsageCoverage, null);
  assert.equal(report.snapshot().total.usage.cacheReadHitRate, null);
  for (let i = 0; i < 1000; i++) {
    const c = call(String(i), { modelId: `model-${i}` });
    report.addCall({ call: c, usage: [] });
    report.addUsage(usage(c), c);
  }
  const r = report.snapshot();
  assert.equal(r.models.length, 32);
  assert.equal(r.unlistedModels.calls.intents, 968);
  assert.equal(r.unlistedModels.usage.usageReports, 968);
  assert.throws(
    () =>
      report.addCall({ call: { ...call("a"), tenantId: "other" }, usage: [] }),
    /scope_invalid/,
  );
  assert.throws(
    () =>
      report.addCall({
        call: call("a"),
        usage: Array(4).fill(usage(call("a"))),
      }),
    /evidence_limit/,
  );
});
