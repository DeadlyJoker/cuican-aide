import { AgentKernelError } from "./agent-kernel-port.ts";
import {
  ModelTransportError,
  type ModelTransportEvent,
} from "./model-transport-port.ts";
import {
  normalizeModelUsage,
  validateModelUsageResponseIdentity,
} from "./model-usage-observer.ts";

type UsageEvent = Extract<ModelTransportEvent, { type: "usage" }>;
const retainedUsage = new WeakMap<ModelTransportError, UsageEvent>();
const fields = [
  "type",
  "callId",
  "providerResponseId",
  "responseStatus",
  "inputTokens",
  "cachedInputTokens",
  "cachedInputTokensReported",
  "outputTokens",
  "totalTokens",
] as const;

function captureUsage(event: UsageEvent): UsageEvent {
  try {
    if (event === null || typeof event !== "object" || Array.isArray(event))
      throw new AgentKernelError(
        "model_transport_failure_usage_invalid",
        false,
      );
    const captured: Record<string, unknown> = {};
    for (const field of fields) {
      const property = Object.getOwnPropertyDescriptor(event, field);
      if (property === undefined) continue;
      if (!("value" in property))
        throw new AgentKernelError(
          "model_transport_failure_usage_invalid",
          false,
        );
      if (property.value !== undefined) captured[field] = property.value;
    }
    if (captured.type !== "usage")
      throw new AgentKernelError(
        "model_transport_failure_usage_invalid",
        false,
      );
    if (
      captured.callId !== undefined &&
      (typeof captured.callId !== "string" ||
        captured.callId.trim().length === 0 ||
        captured.callId.length > 512 ||
        /[\u0000-\u001f]/u.test(captured.callId))
    )
      throw new AgentKernelError("model_usage_call_identity_invalid", false);
    if (
      captured.providerResponseId !== undefined &&
      typeof captured.providerResponseId !== "string"
    )
      throw new AgentKernelError(
        "model_usage_response_identity_invalid",
        false,
      );
    if (
      captured.responseStatus !== undefined &&
      captured.responseStatus !== "failed" &&
      captured.responseStatus !== "incomplete"
    )
      throw new AgentKernelError("model_usage_response_status_invalid", false);
    const usage = captured as UsageEvent;
    normalizeModelUsage(usage);
    validateModelUsageResponseIdentity(usage);
    return Object.freeze(usage);
  } catch (error) {
    let kernelError = false;
    try {
      kernelError = error instanceof AgentKernelError;
    } catch {
      // An arbitrary Proxy trap may itself throw a revoked Proxy.
    }
    if (kernelError) throw error;
    // Proxy traps cannot expose arbitrary exceptions or escape validation.
    throw new AgentKernelError("model_transport_failure_usage_invalid", false);
  }
}

/** Adapter-only accounting evidence; never added to Error fields or public events. */
export function retainModelTransportFailureUsage(
  error: ModelTransportError,
  event: UsageEvent,
): void {
  let transportError = false;
  try {
    transportError = error instanceof ModelTransportError;
  } catch {
    // Revoked proxies and shape lookalikes cannot claim an error identity.
  }
  if (!transportError)
    throw new AgentKernelError(
      "model_transport_failure_identity_invalid",
      false,
    );
  const captured = captureUsage(event);
  const previous = retainedUsage.get(error);
  if (previous !== undefined) {
    if (
      fields.some(
        (field) => field !== "callId" && previous[field] !== captured[field],
      ) ||
      (previous.callId !== undefined &&
        captured.callId !== undefined &&
        previous.callId !== captured.callId)
    )
      throw new AgentKernelError(
        "model_transport_failure_usage_conflict",
        false,
      );
    // The HTTP observer may add its physical call identity to the same evidence.
    if (previous.callId !== undefined || captured.callId === undefined) return;
  }
  retainedUsage.set(error, captured);
}

/** Exact retained identity only: never inspect an exception's fields or cause chain. */
export function modelTransportFailureUsage(error: unknown): UsageEvent | null {
  return retainedUsage.get(error as ModelTransportError) ?? null;
}
