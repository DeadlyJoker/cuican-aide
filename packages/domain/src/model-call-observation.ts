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
      | "firstSemanticMs"
      | "lastSemanticMs"
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

/** Fixed vocabulary only: provider-supplied unknown names never enter diagnostics. */
export const MODEL_HTTP_STREAM_EVENT_TYPES = Object.freeze([
  "response.created",
  "response.in_progress",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.reasoning_text.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_part.added",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.custom_tool_call_input.delta",
  "response.custom_tool_call_input.done",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
  "unknown",
] as const);
export type ModelHttpStreamEventType =
  (typeof MODEL_HTTP_STREAM_EVENT_TYPES)[number];
export const MODEL_HTTP_PENDING_JSON_STATES = Object.freeze([
  "empty",
  "no-data",
  "done-marker",
  "complete-object",
  "complete-nonobject",
  "not-complete-json",
  "multiple-data-events",
] as const);
export type PendingJsonState = (typeof MODEL_HTTP_PENDING_JSON_STATES)[number];
/** Classification only; a complete JSON object is never proof of a validated terminal. */
export type ModelHttpPendingInspection = Readonly<{
  pendingJsonState: PendingJsonState;
  pendingEventType?: ModelHttpStreamEventType;
}>;
export const MODEL_HTTP_STREAM_COUNTER_LIMIT = 2_147_483_647;
export const MODEL_HTTP_STREAM_COUNT_FIELDS = Object.freeze([
  "chunkCount",
  "byteCount",
  "frameCount",
  "commentFrameCount",
  "dataFrameCount",
  "unknownEventCount",
  "textDeltaCount",
  "reasoningDeltaCount",
  "toolArgumentDeltaCount",
  "completedItemCount",
  "terminalEventCount",
] as const);
export type ModelHttpStreamDiagnostics = Readonly<
  Record<(typeof MODEL_HTTP_STREAM_COUNT_FIELDS)[number], number> & {
    pendingFrameBytes: number;
    lastEventType?: ModelHttpStreamEventType;
    pendingJsonState?: PendingJsonState;
    pendingEventType?: ModelHttpStreamEventType;
  }
>;

/** Private correlation evidence; none of these values enter model context or Run SSE. */
export type ModelHttpDiagnostics = Readonly<{
  response?: ModelHttpResponseDiagnostics;
  termination?: ModelHttpTerminationDiagnostics;
  read?: Readonly<{ end: "eof" | "releasedBeforeEof" }>;
  stream?: ModelHttpStreamDiagnostics;
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
      "firstSemanticMs",
      "lastSemanticMs",
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
  if (!diagnosticObject(value, ["response", "termination", "read", "stream"]))
    invalid();
  const streamDescriptor = Object.getOwnPropertyDescriptor(value, "stream");
  if (streamDescriptor !== undefined) {
    if (
      !streamDescriptor.enumerable ||
      !Object.hasOwn(streamDescriptor, "value")
    )
      invalid();
    const stream = streamDescriptor.value;
    if (
      !diagnosticObject(stream, [
        ...MODEL_HTTP_STREAM_COUNT_FIELDS,
        "pendingFrameBytes",
        "lastEventType",
        "pendingJsonState",
        "pendingEventType",
      ])
    )
      invalid();
    if (
      Reflect.ownKeys(stream).some(
        (key) =>
          typeof key !== "string" ||
          ![
            ...MODEL_HTTP_STREAM_COUNT_FIELDS,
            "pendingFrameBytes",
            "lastEventType",
            "pendingJsonState",
            "pendingEventType",
          ].includes(key as never),
      )
    )
      invalid();
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(stream),
    ))
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
        invalid();
    for (const key of [
      ...MODEL_HTTP_STREAM_COUNT_FIELDS,
      "pendingFrameBytes",
    ]) {
      const count = stream[key];
      if (
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count >
          (key === "pendingFrameBytes"
            ? 256 * 1024
            : MODEL_HTTP_STREAM_COUNTER_LIMIT)
      )
        invalid();
    }
    if (
      Object.hasOwn(stream, "pendingJsonState") &&
      !(MODEL_HTTP_PENDING_JSON_STATES as readonly unknown[]).includes(
        stream.pendingJsonState,
      )
    )
      invalid();
    if (
      Object.hasOwn(stream, "pendingEventType") &&
      (stream.pendingJsonState !== "complete-object" ||
        !(MODEL_HTTP_STREAM_EVENT_TYPES as readonly unknown[]).includes(
          stream.pendingEventType,
        ))
    )
      invalid();
    if (
      stream.lastEventType !== undefined &&
      !(MODEL_HTTP_STREAM_EVENT_TYPES as readonly unknown[]).includes(
        stream.lastEventType,
      )
    )
      invalid();
  }
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
