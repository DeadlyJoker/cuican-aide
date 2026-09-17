import { copyModelTokenPricing } from "@crewon/domain";
import { RunStoreError } from "@crewon/application";
import {
  validateModelUsageRecord,
  type ModelCallRecord,
  type ModelUsageRecord,
} from "@crewon/domain";
import { modelUsageLookupKey } from "./model-usage-store-support.ts";
import { stableJson } from "./store-invariants.ts";

export function generationResponseKey(call: ModelCallRecord): string | null {
  const o = call.observation;
  return o.operation !== "generate" ||
    o.outcome === "unknown" ||
    o.providerResponseId === null
    ? null
    : modelUsageLookupKey({
        ...call,
        identity: ["response", o.providerResponseId],
      });
}

/** Validates the reporting invocation; recovering a response is not a new generation. */
export function usageGenerationLookup(
  record: ModelUsageRecord,
  call: ModelCallRecord | null,
):
  | { kind: "unknown" }
  | { kind: "generate"; call: ModelCallRecord }
  | { kind: "retrieve"; responseKey: string; responseId: string } {
  if (call === null) return { kind: "unknown" };
  if (
    record.observation.callId !== call.observation.callId ||
    record.stepId !== call.stepId ||
    record.attemptId !== call.attemptId ||
    modelUsageLookupKey({ ...record, identity: ["observation", "scope"] }) !==
      modelUsageLookupKey({ ...call, identity: ["observation", "scope"] }) ||
    (record.observation.providerResponseId !== null &&
      call.observation.providerResponseId !== null &&
      record.observation.providerResponseId !==
        call.observation.providerResponseId)
  )
    throw new RunStoreError("model_usage_conflict");
  if (call.observation.operation === "generate")
    return { kind: "generate", call };
  const responseId = call.observation.providerResponseId;
  if (responseId === null) return { kind: "unknown" };
  return {
    kind: "retrieve",
    responseId,
    responseKey: modelUsageLookupKey({
      ...record,
      identity: ["response", responseId],
    }),
  };
}

export function usageGeneration(
  record: ModelUsageRecord,
  call: ModelCallRecord | null,
  responseKey?: string,
): ModelUsageRecord["generation"] {
  if (call === null) return undefined;
  if (
    call.observation.operation !== "generate" ||
    modelUsageLookupKey({ ...record, identity: ["observation", "scope"] }) !==
      modelUsageLookupKey({ ...call, identity: ["observation", "scope"] }) ||
    (responseKey !== undefined && generationResponseKey(call) !== responseKey)
  )
    throw new RunStoreError("model_usage_conflict");
  const goal = call.goalAttribution;
  return {
    callId: call.observation.callId,
    ...(call.tokenPricing === undefined
      ? {}
      : { tokenPricing: copyModelTokenPricing(call.tokenPricing) }),
    ...(goal === undefined
      ? {}
      : {
          goalAttribution:
            goal === null
              ? null
              : {
                  threadId: goal.threadId,
                  goalId: goal.goalId,
                  goalRevision: goal.goalRevision,
                  objectiveDigest: goal.objectiveDigest,
                  policy: goal.policy,
                },
        }),
  };
}

/** Unknown legacy attribution is never filled from the current Goal or a later report. */
export function preserveUsageGeneration(
  record: ModelUsageRecord,
  generation: ModelUsageRecord["generation"],
): ModelUsageRecord {
  if (
    record.generation !== undefined &&
    stableJson(record.generation) !==
      (generation === undefined ? undefined : stableJson(generation))
  )
    throw new RunStoreError("model_usage_generation_conflict");
  const { generation: _ignored, ...rest } = record;
  const result = generation === undefined ? rest : { ...rest, generation };
  try {
    validateModelUsageRecord(result);
  } catch {
    throw new RunStoreError("model_usage_record_invalid");
  }
  return result;
}

/** A shared response id is not permission to merge two known generation invocations. */
export function assertUsageGenerationReplay(
  prior: ModelUsageRecord,
  generation: ModelUsageRecord["generation"],
): void {
  if (
    prior.generation !== undefined &&
    generation !== undefined &&
    stableJson(prior.generation) !== stableJson(generation)
  )
    throw new RunStoreError("model_usage_generation_conflict");
}
export function needsUsageGenerationCheck(
  prior: ModelUsageRecord,
  next: ModelUsageRecord,
  verifiedCallAlias: boolean,
): boolean {
  return (
    prior.generation !== undefined &&
    next.observation.callId !== undefined &&
    next.observation.callId !== prior.observation.callId &&
    !verifiedCallAlias
  );
}
