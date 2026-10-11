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

/** Millisecond offsets from client admission, never provider compute time. */
export type ModelHttpTiming = Readonly<
  Partial<
    Record<
      | "admittedMs"
      | "dispatchedMs"
      | "headersMs"
      | "firstByteMs"
      | "lastByteMs"
      | "firstCompletedItemMs"
      | "terminalMs"
      | "streamEndMs"
      | "readClosedMs"
      | "finishedMs",
      number
    >
  >
>;

/** Bounded transport codes only; raw exceptions and response bodies are never persisted. */
export const MODEL_HTTP_NETWORK_CAUSE_CODES = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_DESTROYED",
  "UND_ERR_ABORTED",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
] as const;

export type ModelHttpNetworkCauseCode =
  (typeof MODEL_HTTP_NETWORK_CAUSE_CODES)[number];

export type ModelHttpResponseDiagnostics = Readonly<{
  status: number;
  contentType?: string;
  server?: string;
  cfRay?: string;
  oneApiRequestId?: string;
}>;

export type ModelHttpTerminationDiagnostics = Readonly<{
  reason:
    | "protocolTerminal"
    | "httpError"
    | "idleTimeout"
    | "transportError"
    | "protocolError"
    | "canceled"
    | "consumerInterrupted"
    | "controlSinkError";
  code?: string;
  networkCode?: ModelHttpNetworkCauseCode;
}>;

/** Private correlation evidence; none of these values enter model context or Run SSE. */
export type ModelHttpDiagnostics = Readonly<{
  response?: ModelHttpResponseDiagnostics;
  termination?: ModelHttpTerminationDiagnostics;
  read?: Readonly<{ end: "eof" | "releasedBeforeEof" }>;
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
  /** Additive diagnostics; absent on historical records and non-HTTP adapters. */
  httpTiming?: ModelHttpTiming;
  /** Additive, allowlisted HTTP metadata; absent on historical records. */
  httpDiagnostics?: ModelHttpDiagnostics;
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
  if (o.httpTiming !== undefined) {
    if (
      o.transport !== "http" ||
      o.outcome === "unknown" ||
      o.httpTiming === null ||
      typeof o.httpTiming !== "object" ||
      Array.isArray(o.httpTiming)
    )
      throw new Error("model_call_http_timing_invalid");
    const keys = [
      "admittedMs",
      "dispatchedMs",
      "headersMs",
      "firstByteMs",
      "lastByteMs",
      "firstCompletedItemMs",
      "terminalMs",
      "streamEndMs",
      "readClosedMs",
      "finishedMs",
    ];
    for (const [key, value] of Object.entries(o.httpTiming)) {
      if (!keys.includes(key) || !Number.isSafeInteger(value) || value < 0)
        throw new Error("model_call_http_timing_invalid");
    }
  }
  if (o.httpDiagnostics !== undefined) {
    if (o.transport !== "http" || o.outcome === "unknown")
      throw new Error("model_call_http_diagnostics_invalid");
    validateHttpDiagnostics(o.httpDiagnostics);
  }
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

function validateHttpDiagnostics(value: ModelHttpDiagnostics): void {
  const invalid = () => {
    throw new Error("model_call_http_diagnostics_invalid");
  };
  if (!diagnosticObject(value, ["response", "termination", "read"])) invalid();
  if (value.response !== undefined) {
    const response = value.response;
    if (
      !diagnosticObject(response, [
        "status",
        "contentType",
        "server",
        "cfRay",
        "oneApiRequestId",
      ]) ||
      !Number.isSafeInteger(response.status) ||
      response.status < 100 ||
      response.status > 599
    )
      invalid();
    for (const [key, limit] of [
      ["contentType", 256],
      ["server", 128],
      ["cfRay", 128],
      ["oneApiRequestId", 256],
    ] as const) {
      const header = response[key];
      if (header !== undefined && !boundedDiagnosticHeader(header, limit))
        invalid();
    }
  }
  if (value.termination !== undefined) {
    const termination = value.termination;
    if (
      !diagnosticObject(termination, ["reason", "code", "networkCode"]) ||
      ![
        "protocolTerminal",
        "httpError",
        "idleTimeout",
        "transportError",
        "protocolError",
        "canceled",
        "consumerInterrupted",
        "controlSinkError",
      ].includes(termination.reason) ||
      (termination.code !== undefined &&
        (typeof termination.code !== "string" ||
          !/^[a-z][a-z0-9_]{0,127}$/u.test(termination.code))) ||
      (termination.networkCode !== undefined &&
        !(MODEL_HTTP_NETWORK_CAUSE_CODES as readonly string[]).includes(
          termination.networkCode,
        ))
    )
      invalid();
  }
  if (
    value.read !== undefined &&
    (!diagnosticObject(value.read, ["end"]) ||
      !["eof", "releasedBeforeEof"].includes(value.read.end))
  )
    invalid();
}

function diagnosticObject(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function boundedDiagnosticHeader(
  value: unknown,
  limit: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    value.trim() === value &&
    /^[\u0020-\u007e]+$/u.test(value)
  );
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
