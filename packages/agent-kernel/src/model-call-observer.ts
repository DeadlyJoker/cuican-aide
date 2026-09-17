import { randomUUID } from "node:crypto";
import type { ModelCallObservation } from "@crewon/domain";
import { MODEL_SPENDING_ADMISSION_CODES } from "@crewon/domain";
import {
  ModelTransportError,
  type ModelTransportEvent,
  type ModelTransportStreamOptions,
} from "./model-transport-port.ts";

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
      if (event.type === "completed" || event.type === "failed")
        terminal = event.type;
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
      });
    },
  };
}
