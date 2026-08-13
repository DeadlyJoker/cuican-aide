import type { AutomationInvocationResult } from "@crewon/application";
import type {
  AutomationMutationResponse,
  AutomationView,
  RunAutomationNowResponse,
} from "@crewon/contracts/runtime";
import type { AutomationDefinition } from "@crewon/domain";

import { projectRun } from "./run-projection.ts";

export function projectAutomation(
  definition: AutomationDefinition,
): AutomationView {
  if (definition.executionMode !== "manualOnly" || definition.revision !== 1) {
    throw new Error("automation_projection_state_invalid");
  }
  return {
    automationId: definition.automationId,
    threadId: definition.threadId,
    title: definition.title,
    prompt: definition.prompt,
    agentVersionId: definition.agentVersionId,
    executionMode: "manualOnly",
    automaticScheduling: false,
    revision: 1,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  };
}

export function projectAutomationMutation(input: {
  disposition: "committed" | "replayed";
  definition: AutomationDefinition;
}): AutomationMutationResponse {
  return {
    disposition: input.disposition,
    automation: projectAutomation(input.definition),
  };
}

export function projectAutomationInvocation(
  result: AutomationInvocationResult,
): RunAutomationNowResponse {
  const definition = result.record.definition;
  if (
    result.binding.automationId !== definition.automationId ||
    result.binding.automationRevision !== definition.revision ||
    result.binding.runId !== result.runState.runId ||
    result.runState.threadId !== definition.threadId ||
    result.runState.purpose !== "turn" ||
    result.runState.origin?.kind !== "automation" ||
    result.runState.origin.binding.invocationId !== result.binding.invocationId
  ) {
    throw new Error("automation_invocation_projection_invalid");
  }
  return {
    disposition: result.disposition,
    automation: projectAutomation(definition),
    invocation: {
      automationId: result.binding.automationId,
      runId: result.binding.runId,
    },
    run: projectRun(result.runState),
  };
}
