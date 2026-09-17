import {
  validateModelTokenPricingSnapshot,
  type ModelTokenPricingSnapshot,
} from "./model-token-pricing.ts";
import {
  THREAD_GOAL_ACCOUNTING_POLICY,
  validateRunGoalBinding,
} from "./thread-goal.ts";

/** Immutable attribution at dispatch admission; no objective text enters the ledger. */
export type ModelCallGoalAttribution = Readonly<{
  threadId: string;
  goalId: string;
  goalRevision: number;
  objectiveDigest: string;
  policy: typeof THREAD_GOAL_ACCOUNTING_POLICY;
}>;

/** Accounting evidence for a provider request, not authority to retry its effects. */
export type ModelCallObservation = Readonly<{
  schemaVersion: "crewon.model-call-observation.v0";
  callId: string;
  purpose: "agent" | "compaction";
  agentVersionId: string;
  adapterName: string;
  adapterVersion: string;
  modelId: string;
  transport: "http" | "websocket" | "cloudAgent";
  operation: "generate" | "retrieve";
  /** Declared provider output ceiling, including reasoning; absent is unknown/unconfigured. */
  maxOutputTokens?: number;
  /** Intent is committed before I/O; a crash may leave whether it was sent unknown. */
  startedAt: string;
  finishedAt: string | null;
  outcome: "unknown" | "completed" | "failed" | "canceled" | "interrupted";
  providerResponseId: string | null;
  firstOutputLatencyMs: number | null;
  /** A validated transport usage event was seen; persistence is a separate fact. */
  usageEventObserved: boolean;
}>;
export type ModelCallRecord = Readonly<{
  tenantId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  /** Store-owned dispatch snapshot. Null is confirmed unbound; absent is legacy/unknown. */
  goalAttribution?: ModelCallGoalAttribution | null;
  /** Store-owned immutable price at generation admission, never added to model input. */
  tokenPricing?: ModelTokenPricingSnapshot;
  observation: ModelCallObservation;
}>;
export interface ModelCallObservationSink {
  record(observation: ModelCallObservation): Promise<void>;
}

export function validateModelCallRecord(record: ModelCallRecord): void {
  if (record.goalAttribution !== undefined && record.goalAttribution !== null)
    validateModelCallGoalAttribution(record.goalAttribution);
  if (record.tokenPricing !== undefined) {
    validateModelTokenPricingSnapshot(record.tokenPricing);
    if (
      record.observation.operation !== "generate" ||
      record.observation.transport === "cloudAgent"
    )
      throw new Error("model_call_pricing_scope_invalid");
  }
  const o = record.observation;
  if (
    o.maxOutputTokens !== undefined &&
    (o.operation !== "generate" ||
      !Number.isSafeInteger(o.maxOutputTokens) ||
      o.maxOutputTokens < 1)
  )
    throw new Error("model_call_output_limit_invalid");
  for (const id of [
    record.tenantId,
    record.runId,
    record.stepId,
    record.attemptId,
    o.callId,
    o.agentVersionId,
  ])
    identity(id, 512);
  identity(o.adapterName, 128);
  identity(o.adapterVersion, 128);
  identity(o.modelId, 256);
  if (o.providerResponseId !== null) identity(o.providerResponseId, 512);
  if (
    o.schemaVersion !== "crewon.model-call-observation.v0" ||
    !["agent", "compaction"].includes(o.purpose) ||
    !["http", "websocket", "cloudAgent"].includes(o.transport) ||
    !["generate", "retrieve"].includes(o.operation) ||
    !["unknown", "completed", "failed", "canceled", "interrupted"].includes(
      o.outcome,
    ) ||
    (o.finishedAt === null) !== (o.outcome === "unknown")
  )
    throw new Error("model_call_observation_invalid");
  if (
    o.outcome === "unknown" &&
    (o.firstOutputLatencyMs !== null ||
      (o.operation === "generate" && o.providerResponseId !== null))
  )
    throw new Error("model_call_intent_invalid");
  if (
    typeof o.usageEventObserved !== "boolean" ||
    (o.outcome === "unknown" && o.usageEventObserved)
  )
    throw new Error("model_call_usage_marker_invalid");
  timestamp(o.startedAt);
  if (o.finishedAt !== null) timestamp(o.finishedAt);
  if (
    o.firstOutputLatencyMs !== null &&
    (!Number.isSafeInteger(o.firstOutputLatencyMs) ||
      o.firstOutputLatencyMs < 0)
  )
    throw new Error("model_call_latency_invalid");
  if (new TextEncoder().encode(JSON.stringify(record)).byteLength > 8192)
    throw new Error("model_call_record_too_large");
}
export function validateModelCallGoalAttribution(
  value: ModelCallGoalAttribution,
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.policy !== THREAD_GOAL_ACCOUNTING_POLICY
  )
    throw new Error("model_call_goal_attribution_invalid");
  identity(value.threadId, 512);
  validateRunGoalBinding({
    goalId: value.goalId,
    revision: value.goalRevision,
    objectiveDigest: value.objectiveDigest,
  });
}
function identity(value: string, limit: number): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > limit ||
    /[\u0000-\u001f]/u.test(value)
  )
    throw new Error("model_call_identity_invalid");
}
function timestamp(value: string): void {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("model_call_timestamp_invalid");
}
