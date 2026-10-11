import { preserveModelCallPricing } from "./model-pricing-store-support.ts";
import { createHash } from "node:crypto";
import {
  RunStoreError,
  type RecordModelCallInput,
  type ModelCallEntry,
  type ModelUsagePageQuery,
} from "@crewon/application";
import { validateModelCallRecord, type ModelCallRecord } from "@crewon/domain";
import { stableJson, validateQueueLease } from "./store-invariants.ts";
import { preserveModelCallAttribution } from "./model-call-goal-attribution.ts";

export function modelCallKey(
  record: Pick<ModelCallRecord, "tenantId" | "runId"> & {
    observation: Pick<ModelCallRecord["observation"], "callId">;
  },
): string {
  return createHash("sha256")
    .update(
      stableJson([record.tenantId, record.runId, record.observation.callId]),
    )
    .digest("hex");
}
export function validateModelCallInput(input: RecordModelCallInput): void {
  try {
    validateModelCallRecord(input.record);
  } catch {
    throw new RunStoreError("model_call_record_invalid");
  }
  validateQueueLease(
    input.lease,
    input.lease.workItemId,
    "work_item_id_invalid",
  );
}
export function mergeModelCallReplay(
  prior: ModelCallRecord,
  next: ModelCallRecord,
): ModelCallRecord | null {
  next = preserveModelCallPricing(
    preserveModelCallAttribution(next, prior.goalAttribution),
    prior.tokenPricing,
  );
  const {
    outcome: _a,
    finishedAt: _b,
    providerResponseId: _c,
    firstOutputLatencyMs: _d,
    usageEventObserved: _i,
    httpTiming: _k,
    httpDiagnostics: _m,
    ...before
  } = prior.observation;
  const {
    outcome: _e,
    finishedAt: _f,
    providerResponseId: _g,
    firstOutputLatencyMs: _h,
    usageEventObserved: _j,
    httpTiming: _l,
    httpDiagnostics: _n,
    ...after
  } = next.observation;
  if (
    prior.tenantId !== next.tenantId ||
    prior.runId !== next.runId ||
    prior.stepId !== next.stepId ||
    prior.attemptId !== next.attemptId ||
    stableJson(before) !== stableJson(after) ||
    (prior.observation.providerResponseId !== null &&
      next.observation.providerResponseId !== null &&
      prior.observation.providerResponseId !==
        next.observation.providerResponseId)
  )
    throw new RunStoreError("model_call_conflict");
  if (stableJson(prior) === stableJson(next)) return null;
  if (next.observation.outcome === "unknown") return null; // Replayed intent cannot erase a result.
  if (prior.observation.outcome !== "unknown")
    throw new RunStoreError("model_call_conflict");
  return next;
}
export function decodeModelCallEntry(
  order: unknown,
  value: unknown,
  query: Pick<ModelUsagePageQuery, "tenantId" | "runId">,
): ModelCallEntry {
  let record: ModelCallRecord;
  try {
    record = typeof value === "string" ? JSON.parse(value) : value;
    validateModelCallRecord(record);
  } catch {
    throw new RunStoreError("model_call_record_invalid");
  }
  if (
    !Number.isSafeInteger(Number(order)) ||
    Number(order) < 1 ||
    record.tenantId !== query.tenantId ||
    record.runId !== query.runId
  )
    throw new RunStoreError("model_call_record_invalid");
  return { order: Number(order), record };
}

export function validateNewModelCall(record: ModelCallRecord): void {
  if (
    record.observation.outcome !== "unknown" ||
    record.observation.firstOutputLatencyMs !== null
  )
    throw new RunStoreError("model_call_begin_missing");
}
