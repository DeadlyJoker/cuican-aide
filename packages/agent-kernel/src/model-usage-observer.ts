import { randomUUID } from "node:crypto";
import type {
  ModelUsageObservation,
  ModelUsageObservationSink,
} from "@crewon/domain";
import {
  AgentKernelError,
  type AgentSegmentContract,
  type KernelAgentEvent,
  type AgentKernelPort,
} from "./agent-kernel-port.ts";
import type { ModelTransportEvent } from "./model-transport-port.ts";

type UsageEvent = Extract<ModelTransportEvent, { type: "usage" }>;

/** Shared numeric validation for public events and private failure accounting. */
export function normalizeModelUsage(
  event: UsageEvent,
): ModelUsageObservation["usage"] {
  if (
    (event.cachedInputTokens !== undefined &&
      !Number.isSafeInteger(event.cachedInputTokens)) ||
    (event.cachedInputTokensReported !== undefined &&
      typeof event.cachedInputTokensReported !== "boolean") ||
    (event.cachedInputTokensReported === true &&
      event.cachedInputTokens === undefined) ||
    (event.cachedInputTokensReported === false &&
      (event.cachedInputTokens ?? 0) !== 0)
  ) {
    throw new AgentKernelError("model_usage_cache_reporting_invalid", false);
  }
  for (const value of [
    event.inputTokens,
    event.cachedInputTokens ?? 0,
    event.outputTokens,
    event.totalTokens,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AgentKernelError("model_usage_invalid", false);
    }
  }
  if (event.totalTokens !== event.inputTokens + event.outputTokens) {
    throw new AgentKernelError("model_usage_total_mismatch", false);
  }
  if ((event.cachedInputTokens ?? 0) > event.inputTokens) {
    throw new AgentKernelError("model_usage_cached_input_exceeds_input", false);
  }
  return {
    inputTokens: event.inputTokens,
    cachedInputTokens: event.cachedInputTokens ?? 0,
    cachedInputTokensReported:
      event.cachedInputTokensReported ?? event.cachedInputTokens !== undefined,
    outputTokens: event.outputTokens,
    totalTokens: event.totalTokens,
  };
}

export function validateModelUsageResponseIdentity(event: UsageEvent): void {
  const providerResponseId = event.providerResponseId ?? null;
  const responseStatus = event.responseStatus ?? null;
  if (
    responseStatus !== null &&
    responseStatus !== "failed" &&
    responseStatus !== "incomplete"
  )
    throw new AgentKernelError("model_usage_response_status_invalid", false);
  if (
    providerResponseId !== null &&
    (typeof providerResponseId !== "string" ||
      providerResponseId.trim().length === 0 ||
      providerResponseId.length > 512 ||
      /[\u0000-\u001f]/u.test(providerResponseId))
  )
    throw new AgentKernelError("model_usage_response_identity_invalid", false);
}

export async function observeModelUsage(input: {
  sink: ModelUsageObservationSink | undefined;
  contract: AgentSegmentContract;
  model: AgentKernelPort["modelIdentity"];
  event: Extract<ModelTransportEvent, { type: "usage" }>;
  usage: Extract<KernelAgentEvent, { type: "usage.recorded" }>["data"] & {
    cachedInputTokensReported: boolean;
  };
}): Promise<void> {
  validateModelUsageResponseIdentity(input.event);
  const providerResponseId = input.event.providerResponseId ?? null;
  const responseStatus = input.event.responseStatus ?? null;
  await input.sink?.observed({
    schemaVersion: "crewon.model-usage-observation.v0",
    observationId: randomUUID(),
    ...(input.event.callId === undefined ? {} : { callId: input.event.callId }),
    providerResponseId,
    responseStatus,
    purpose: input.contract.purpose,
    agentVersionId: input.contract.agentVersionId,
    ...input.model,
    usage: input.usage,
  });
}
