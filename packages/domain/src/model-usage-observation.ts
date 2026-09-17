import {
  validateModelTokenPricingSnapshot,
  type ModelTokenPricingSnapshot,
} from "./model-token-pricing.ts";
import {
  validateModelCallGoalAttribution,
  type ModelCallGoalAttribution,
} from "./model-call-observation.ts";
import { cacheReadReportingError } from "./model-usage-report.ts";

/** Provider-reported usage, independent of whether generated content is committed. */
export type ModelUsageObservation = Readonly<{
  schemaVersion: "crewon.model-usage-observation.v0";
  observationId: string;
  /** One physical invocation within a Run; never reused for another model/purpose. Absent on older records. */
  callId?: string;
  providerResponseId: string | null;
  responseStatus: "failed" | "incomplete" | null;
  purpose: "agent" | "compaction";
  agentVersionId: string;
  adapterName: string;
  adapterVersion: string;
  modelId: string;
  usage: Readonly<{
    inputTokens: number;
    cachedInputTokens: number;
    cachedInputTokensReported: boolean;
    outputTokens: number;
    totalTokens: number;
  }>;
}>;

export interface ModelUsageObservationSink {
  observed(observation: ModelUsageObservation): Promise<void>;
}

export type ModelUsageRecord = Readonly<{
  tenantId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  observedAt: string;
  /** Store-owned original generation, not the later retrieval interval. Absent means unknown. */
  generation?: Readonly<{
    callId: string;
    goalAttribution?: ModelCallGoalAttribution | null;
    tokenPricing?: ModelTokenPricingSnapshot;
  }>;
  observation: ModelUsageObservation;
}>;

export function validateModelUsageRecord(record: ModelUsageRecord): void {
  if (record.generation !== undefined) {
    const generation = record.generation;
    if (
      typeof generation !== "object" ||
      generation === null ||
      Array.isArray(generation)
    )
      throw new Error("model_usage_generation_invalid");
    boundedIdentity(generation.callId, 512);
    if (generation.tokenPricing !== undefined)
      validateModelTokenPricingSnapshot(generation.tokenPricing);
    if (
      generation.goalAttribution !== undefined &&
      generation.goalAttribution !== null
    )
      validateModelCallGoalAttribution(generation.goalAttribution);
  }
  for (const value of [
    record.tenantId,
    record.runId,
    record.stepId,
    record.attemptId,
  ])
    boundedIdentity(value, 512);
  if (
    typeof record.observedAt !== "string" ||
    record.observedAt.length > 64 ||
    !Number.isFinite(Date.parse(record.observedAt))
  )
    throw new Error("model_usage_timestamp_invalid");
  const observation = record.observation;
  if (
    observation.responseStatus !== null &&
    observation.responseStatus !== "failed" &&
    observation.responseStatus !== "incomplete"
  )
    throw new Error("model_usage_response_status_invalid");
  if (
    observation.schemaVersion !== "crewon.model-usage-observation.v0" ||
    (observation.purpose !== "agent" && observation.purpose !== "compaction")
  )
    throw new Error("model_usage_observation_invalid");
  boundedIdentity(observation.observationId, 512);
  if (observation.callId !== undefined)
    boundedIdentity(observation.callId, 512);
  if (observation.providerResponseId !== null)
    boundedIdentity(observation.providerResponseId, 512);
  boundedIdentity(observation.agentVersionId, 512);
  boundedIdentity(observation.adapterName, 128);
  boundedIdentity(observation.adapterVersion, 128);
  boundedIdentity(observation.modelId, 256);
  const usage = observation.usage;
  if (
    [
      usage.inputTokens,
      usage.cachedInputTokens,
      usage.outputTokens,
      usage.totalTokens,
    ].some((value) => !Number.isSafeInteger(value) || value < 0) ||
    usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
    usage.cachedInputTokens > usage.inputTokens ||
    typeof usage.cachedInputTokensReported !== "boolean" ||
    cacheReadReportingError(usage) !== null
  )
    throw new Error("model_usage_tokens_invalid");
  if (new TextEncoder().encode(JSON.stringify(record)).byteLength > 8192)
    throw new Error("model_usage_record_too_large");
}

function boundedIdentity(value: string, limit: number): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > limit ||
    /[\u0000-\u001f]/u.test(value)
  )
    throw new Error("model_usage_identity_invalid");
}
