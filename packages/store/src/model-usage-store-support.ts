import { preserveUsageGeneration } from "./model-usage-generation.ts";
import { createHash } from "node:crypto";
import {
  RunStoreError,
  type ModelUsageEntry,
  type ModelUsagePageQuery,
  type RecordModelUsageInput,
} from "@crewon/application";
import {
  validateModelUsageRecord,
  type ModelUsageRecord,
  type RunAttemptState,
  type RunStepState,
} from "@crewon/domain";
import { stableJson, validateQueueLease } from "./store-invariants.ts";

export function validateModelUsageInput(input: RecordModelUsageInput): void {
  try {
    validateModelUsageRecord(input.record);
  } catch {
    throw new RunStoreError("model_usage_record_invalid");
  }
  validateQueueLease(
    input.lease,
    input.lease.workItemId,
    "work_item_id_invalid",
  );
}

export function modelUsageKey(record: ModelUsageRecord): string {
  const o = record.observation;
  return modelUsageLookupKey({
    ...record,
    observation: o,
    identity:
      o.providerResponseId !== null
        ? ["response", o.providerResponseId]
        : o.callId !== undefined
          ? ["call", o.callId]
          : ["observation", o.observationId],
  });
}

export function modelUsageLookupKey(
  record: Pick<ModelUsageRecord, "tenantId" | "runId"> & {
    observation: Pick<
      ModelUsageRecord["observation"],
      | "agentVersionId"
      | "adapterName"
      | "adapterVersion"
      | "modelId"
      | "purpose"
    >;
    identity: readonly ["response" | "call" | "observation", string];
  },
): string {
  const o = record.observation;
  return createHash("sha256")
    .update(
      stableJson([
        record.tenantId,
        record.runId,
        o.agentVersionId,
        o.adapterName,
        o.adapterVersion,
        o.modelId,
        o.purpose,
        record.identity,
      ]),
    )
    .digest("hex");
}

/** Enrich missing metadata without replacing the first observation's provenance. */
export function mergeModelUsageReplay(
  prior: ModelUsageRecord,
  next: ModelUsageRecord,
  identity: { verifiedCallAlias: boolean } = { verifiedCallAlias: false },
): ModelUsageRecord | null {
  next = preserveUsageGeneration(next, prior.generation);
  const before = prior.observation;
  const after = next.observation;
  if (
    modelUsageLookupKey({ ...prior, identity: ["observation", "scope"] }) !==
      modelUsageLookupKey({ ...next, identity: ["observation", "scope"] }) ||
    (before.providerResponseId !== null &&
      after.providerResponseId !== null &&
      before.providerResponseId !== after.providerResponseId) ||
    !(
      modelUsageKey(prior) === modelUsageKey(next) ||
      identity.verifiedCallAlias ||
      (before.callId !== undefined && before.callId === after.callId)
    ) ||
    before.usage.inputTokens !== after.usage.inputTokens ||
    before.usage.outputTokens !== after.usage.outputTokens ||
    before.usage.totalTokens !== after.usage.totalTokens ||
    (before.responseStatus !== null &&
      after.responseStatus !== null &&
      before.responseStatus !== after.responseStatus) ||
    (before.usage.cachedInputTokensReported &&
      after.usage.cachedInputTokensReported &&
      before.usage.cachedInputTokens !== after.usage.cachedInputTokens)
  )
    throw new RunStoreError("model_usage_conflict");
  const enrichCache =
    !before.usage.cachedInputTokensReported &&
    after.usage.cachedInputTokensReported;
  const enrichStatus =
    before.responseStatus === null && after.responseStatus !== null;
  const enrichResponse =
    before.providerResponseId === null && after.providerResponseId !== null;
  if (!enrichCache && !enrichStatus && !enrichResponse) return null;
  return {
    ...prior,
    observation: {
      ...before,
      providerResponseId: before.providerResponseId ?? after.providerResponseId,
      responseStatus: before.responseStatus ?? after.responseStatus,
      usage: enrichCache ? after.usage : before.usage,
    },
  };
}

export function validateModelUsageAttempt(
  input: Pick<RecordModelUsageInput, "lease"> & {
    record: Pick<
      ModelUsageRecord,
      "tenantId" | "runId" | "stepId" | "attemptId"
    >;
  },
  attempt: RunAttemptState | null,
  step: RunStepState | null,
): void {
  if (
    step?.kind !== "model" ||
    step.status !== "running" ||
    step.currentAttemptId !== input.record.attemptId
  )
    throw new RunStoreError("model_usage_attempt_mismatch");
  if (
    attempt === null ||
    attempt.tenantId !== input.record.tenantId ||
    attempt.runId !== input.record.runId ||
    attempt.stepId !== input.record.stepId ||
    attempt.attemptId !== input.record.attemptId ||
    attempt.workItemId !== input.lease.workItemId ||
    attempt.leaseEpoch !== input.lease.leaseEpoch ||
    attempt.status !== "running"
  )
    throw new RunStoreError("model_usage_attempt_mismatch");
}

export function validateModelUsagePage(query: ModelUsagePageQuery): void {
  if (
    [query.tenantId, query.runId].some(
      (value) =>
        typeof value !== "string" ||
        value.trim().length === 0 ||
        value.length > 512,
    ) ||
    !Number.isSafeInteger(query.afterOrder) ||
    query.afterOrder < 0 ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 128
  )
    throw new RunStoreError("model_usage_page_invalid");
}

export function decodeModelUsageEntry(
  order: unknown,
  value: unknown,
  query: Pick<ModelUsagePageQuery, "tenantId" | "runId">,
): ModelUsageEntry {
  let record: ModelUsageRecord;
  try {
    record =
      typeof value === "string"
        ? (JSON.parse(value) as ModelUsageRecord)
        : (value as ModelUsageRecord);
    validateModelUsageRecord(record);
  } catch {
    throw new RunStoreError("model_usage_record_invalid");
  }
  if (
    !Number.isSafeInteger(Number(order)) ||
    Number(order) < 1 ||
    record.tenantId !== query.tenantId ||
    record.runId !== query.runId
  )
    throw new RunStoreError("model_usage_record_invalid");
  return { order: Number(order), record };
}
