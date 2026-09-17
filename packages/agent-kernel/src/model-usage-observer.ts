import { randomUUID } from "node:crypto";
import type { ModelUsageObservationSink } from "@crewon/domain";
import {
  AgentKernelError,
  type AgentSegmentContract,
  type KernelAgentEvent,
  type AgentKernelPort,
} from "./agent-kernel-port.ts";
import type { ModelTransportEvent } from "./model-transport-port.ts";

export async function observeModelUsage(input: {
  sink: ModelUsageObservationSink | undefined;
  contract: AgentSegmentContract;
  model: AgentKernelPort["modelIdentity"];
  event: Extract<ModelTransportEvent, { type: "usage" }>;
  usage: Extract<KernelAgentEvent, { type: "usage.recorded" }>["data"] & {
    cachedInputTokensReported: boolean;
  };
}): Promise<void> {
  const providerResponseId = input.event.providerResponseId ?? null;
  const responseStatus = input.event.responseStatus ?? null;
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
