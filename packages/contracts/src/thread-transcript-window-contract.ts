import type { components } from "./generated/control-api.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import { parseRunId } from "./control-api-contract.ts";
import {
  parseThreadMessageWindowResponse,
  type ThreadMessageWindowQuery,
} from "./thread-message-window-contract.ts";

export type GetThreadTranscriptWindowResponse =
  components["schemas"]["GetThreadTranscriptWindowResponse"];
export const MAX_THREAD_TRANSCRIPT_WINDOW_RESPONSE_BYTES = 6 * 1024 * 1024;

export function parseThreadTranscriptWindowResponse(
  input: unknown,
  threadId: string,
  query: ThreadMessageWindowQuery,
): GetThreadTranscriptWindowResponse {
  const fail = (): never => {
    throw new ContractValidationError("transcript_window_response_invalid");
  };
  if (
    !record(input) ||
    Object.keys(input).length !== 3 ||
    input.schemaVersion !== "crewon.transcript-window.v0" ||
    !Array.isArray(input.runBindings)
  )
    return fail();
  const messageWindow = parseThreadMessageWindowResponse(
    input.messageWindow,
    threadId,
    query,
  );
  if (input.runBindings.length !== messageWindow.data.length) fail();
  const runBindings = input.runBindings.map(
    (
      binding,
      index,
    ): GetThreadTranscriptWindowResponse["runBindings"][number] => {
      const message = messageWindow.data[index]!;
      if (
        !record(binding) ||
        Object.keys(binding).length !== 3 ||
        binding.messageId !== message.messageId
      )
        return fail();
      const source = binding.source;
      if (source === "unassociated") {
        if (binding.runId !== null) return fail();
        return { messageId: message.messageId, runId: null, source };
      }
      if (
        (source !== "turnStartReceipt" || message.role !== "user") &&
        (source !== "messageCompletedEvent" || message.role !== "assistant")
      )
        return fail();
      const runId = parseRunId(binding.runId);
      if (message.proposedPlan !== null && message.proposedPlan.runId !== runId)
        return fail();
      return { messageId: message.messageId, runId, source };
    },
  );
  return {
    schemaVersion: "crewon.transcript-window.v0",
    messageWindow,
    runBindings,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
