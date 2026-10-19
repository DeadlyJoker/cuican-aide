export { MODEL_HTTP_STREAM_EVENT_TYPES } from "@crewon/domain";
export type {
  ModelHttpStreamEventType,
  PendingJsonState,
  ModelHttpPendingInspection,
} from "@crewon/domain";
import { randomUUID } from "node:crypto";
import type {
  ModelCallObservation,
  ModelHttpDiagnostics,
  ModelHttpTiming,
  ModelHttpStreamEventType,
  ModelHttpStreamDiagnostics,
  ModelHttpPendingInspection,
} from "@crewon/domain";
import {
  MODEL_HTTP_STREAM_EVENT_TYPES,
  MODEL_HTTP_PENDING_JSON_STATES,
  MODEL_HTTP_STREAM_COUNT_FIELDS,
  MODEL_HTTP_STREAM_COUNTER_LIMIT,
  MODEL_SPENDING_ADMISSION_CODES,
} from "@crewon/domain";
import {
  ModelTransportError,
  type ModelTransportEvent,
  type ModelTransportStreamOptions,
} from "./model-transport-port.ts";
import {
  modelHttpResponseDiagnostics,
  modelHttpTerminationDiagnostics,
} from "./model-http-diagnostics.ts";

/** One object per prepared adapter request, including retries hidden below Kernel. */
export async function beginModelCall(input: {
  options: ModelTransportStreamOptions | undefined;
  identity: {
    agentVersionId: string;
    adapterName: string;
    adapterVersion: string;
    modelId: string;
  };
  transport: ModelCallObservation["transport"];
  operation: ModelCallObservation["operation"];
  signal: AbortSignal;
  providerResponseId?: string;
  maxOutputTokens?: number | undefined;
}) {
  const sink = input.options?.callSink;
  if (!sink) return null;
  input.signal.throwIfAborted();
  const started = performance.now();
  const initial: ModelCallObservation = {
    schemaVersion: "crewon.model-call-observation.v0",
    callId: randomUUID(),
    ...input.identity,
    purpose: sink.purpose,
    transport: input.transport,
    operation: input.operation,
    ...(input.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: input.maxOutputTokens }),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outcome: "unknown",
    providerResponseId: input.providerResponseId ?? null,
    firstOutputLatencyMs: null,
    usageEventObserved: false,
  };
  const record = async (value: ModelCallObservation) => {
    try {
      await sink.record(value);
    } catch (cause) {
      const code =
        typeof cause === "object" && cause !== null && "code" in cause
          ? cause.code
          : null;
      throw new ModelTransportError({
        category: "protocol",
        code:
          typeof code === "string" &&
          (MODEL_SPENDING_ADMISSION_CODES as readonly string[]).includes(code)
            ? code
            : "model_call_accounting_failed",
        retryable: false,
        cause,
      });
    }
  };
  await record(initial);
  const httpTiming: Partial<Record<keyof ModelHttpTiming, number>> = {};
  const httpDiagnostics: {
    -readonly [K in keyof ModelHttpDiagnostics]: ModelHttpDiagnostics[K];
  } = {};
  const httpPhase = (phase: keyof ModelHttpTiming) => {
    if (input.transport !== "http") return;
    if (
      httpTiming[phase] === undefined ||
      phase === "lastByteMs" ||
      phase === "lastSemanticMs"
    )
      httpTiming[phase] = Math.max(0, Math.round(performance.now() - started));
  };
  const stream: {
    -readonly [K in keyof ModelHttpStreamDiagnostics]: ModelHttpStreamDiagnostics[K];
  } = {
    ...(Object.fromEntries(
      MODEL_HTTP_STREAM_COUNT_FIELDS.map((key) => [key, 0]),
    ) as Record<(typeof MODEL_HTTP_STREAM_COUNT_FIELDS)[number], number>),
    pendingFrameBytes: 0,
  };
  const count = (
    key: (typeof MODEL_HTTP_STREAM_COUNT_FIELDS)[number],
    amount = 1,
  ) => {
    stream[key] = Math.min(
      MODEL_HTTP_STREAM_COUNTER_LIMIT,
      stream[key] + amount,
    );
    httpDiagnostics.stream = stream;
  };
  httpPhase("admittedMs");
  // Cancellation during the durable admission must prevent the subsequent I/O.
  if (input.signal.aborted) {
    await record({
      ...initial,
      finishedAt: new Date().toISOString(),
      outcome: "canceled",
    });
    input.signal.throwIfAborted();
  }
  let responseId = initial.providerResponseId;
  let firstOutputLatencyMs: number | null = null;
  let terminal: "completed" | "failed" | null = null;
  let finished = false;
  let usageEventObserved = false;
  const responseIdentity = (id: string) => {
    // The decoder owns strict versus terminal-authoritative identity policy.
    responseId = id;
  };
  return {
    responseIdentity,
    httpPhase,
    httpStreamChunk(bytes: number) {
      if (input.transport !== "http") return;
      count("chunkCount");
      count("byteCount", bytes);
    },
    httpStreamFrame(kind: "comment" | "data" | "done" | "ignored") {
      if (input.transport !== "http") return;
      count("frameCount");
      if (kind === "comment") count("commentFrameCount");
      if (kind === "data") count("dataFrameCount");
    },
    httpStreamPending(bytes: number) {
      if (input.transport !== "http") return;
      stream.pendingFrameBytes = Math.min(256 * 1024, bytes);
      httpDiagnostics.stream = stream;
    },
    httpStreamPendingInspection(inspection: ModelHttpPendingInspection) {
      if (input.transport !== "http") return;
      // Diagnostic failures must never replace the stream's original outcome.
      try {
        const fields = Object.getOwnPropertyDescriptors(inspection);
        const state = fields.pendingJsonState;
        const type = fields.pendingEventType;
        if (
          !state ||
          !Object.hasOwn(state, "value") ||
          !(MODEL_HTTP_PENDING_JSON_STATES as readonly unknown[]).includes(
            state.value,
          ) ||
          Reflect.ownKeys(fields).some(
            (key) => key !== "pendingJsonState" && key !== "pendingEventType",
          ) ||
          (type &&
            (!Object.hasOwn(type, "value") ||
              state.value !== "complete-object" ||
              !(MODEL_HTTP_STREAM_EVENT_TYPES as readonly unknown[]).includes(
                type.value,
              )))
        )
          return;
        stream.pendingJsonState = state.value;
        if (type) stream.pendingEventType = type.value;
        else delete stream.pendingEventType;
        httpDiagnostics.stream = stream;
      } catch {
        /* Optional evidence cannot fail accounting or delivery. */
      }
    },
    httpStreamEvent(
      eventType: ModelHttpStreamEventType,
      semantic: boolean,
      category?:
        | "textDeltaCount"
        | "reasoningDeltaCount"
        | "toolArgumentDeltaCount"
        | "completedItemCount"
        | "terminalEventCount",
    ) {
      if (input.transport !== "http") return;
      stream.lastEventType = eventType;
      httpDiagnostics.stream = stream;
      if (eventType === "unknown") count("unknownEventCount");
      if (category !== undefined) count(category);
      if (semantic) {
        httpPhase("firstSemanticMs");
        httpPhase("lastSemanticMs");
      }
    },
    httpResponse(
      status: number,
      headers: Parameters<typeof modelHttpResponseDiagnostics>[1],
    ) {
      if (input.transport !== "http" || httpDiagnostics.response !== undefined)
        return;
      const response = modelHttpResponseDiagnostics(status, headers);
      if (response !== null) httpDiagnostics.response = response;
    },
    httpReadClosed(state: Readonly<{ endOfBody: boolean }>) {
      if (input.transport !== "http") return;
      httpPhase("readClosedMs");
      httpDiagnostics.read = {
        end: state.endOfBody ? "eof" : "releasedBeforeEof",
      };
    },
    httpFailure(
      failure: Parameters<typeof modelHttpTerminationDiagnostics>[0],
    ) {
      if (input.transport !== "http") return;
      httpDiagnostics.termination = modelHttpTerminationDiagnostics(failure);
    },
    event(event: ModelTransportEvent): ModelTransportEvent {
      if (
        event.type === "output.delta" &&
        event.delta &&
        firstOutputLatencyMs === null
      )
        firstOutputLatencyMs = Math.max(
          0,
          Math.round(performance.now() - started),
        );
      if (event.type === "output.item.completed")
        httpPhase("firstCompletedItemMs");
      if (event.type === "completed" || event.type === "failed") {
        terminal = event.type;
        httpPhase("terminalMs");
        if (input.transport === "http")
          httpDiagnostics.termination = modelHttpTerminationDiagnostics({
            reason: "protocolTerminal",
            ...(event.type === "failed" ? { code: event.code } : {}),
          });
      }
      if (event.type === "response.created") {
        const payload = event.checkpoint.opaquePayload;
        if (
          payload !== null &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          typeof payload.responseId === "string"
        )
          responseIdentity(payload.responseId);
      }
      if (event.type === "usage") {
        usageEventObserved = true;
        if (event.providerResponseId !== undefined)
          responseIdentity(event.providerResponseId);
        return { ...event, callId: initial.callId };
      }
      return event;
    },
    async finish(
      outcome: Exclude<ModelCallObservation["outcome"], "unknown">,
    ): Promise<void> {
      if (finished) return;
      finished = true;
      httpPhase("finishedMs");
      if (
        input.transport === "http" &&
        httpDiagnostics.termination === undefined &&
        (outcome === "canceled" || outcome === "interrupted")
      )
        httpDiagnostics.termination = {
          reason: outcome === "canceled" ? "canceled" : "consumerInterrupted",
        };
      await record({
        ...initial,
        finishedAt: new Date().toISOString(),
        outcome:
          terminal === "failed"
            ? "failed"
            : outcome === "interrupted" && terminal !== null
              ? terminal
              : outcome,
        providerResponseId: responseId,
        firstOutputLatencyMs,
        usageEventObserved,
        ...(Object.keys(httpTiming).length === 0 ? {} : { httpTiming }),
        ...(Object.keys(httpDiagnostics).length === 0
          ? {}
          : { httpDiagnostics }),
      });
    },
  };
}
