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
  observation: ModelCallObservation;
}>;
export interface ModelCallObservationSink {
  record(observation: ModelCallObservation): Promise<void>;
}

export function validateModelCallRecord(record: ModelCallRecord): void {
  const o = record.observation;
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
