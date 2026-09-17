import type { CanonicalAgentEvent } from "@crewon/contracts";
import { ApplicationError } from "./application-error.ts";
import { requireBoundedContent } from "./run-execution-support.ts";

export function validateAssistantContinuationContent(
  input: Readonly<{
    output: string;
    completedAssistantItems: readonly string[];
    events: readonly CanonicalAgentEvent[];
  }>,
): "empty" | "content" {
  if (input.completedAssistantItems.length === 0) {
    if (
      input.output !== "" ||
      input.events.some(
        (event) =>
          event.type === "tool.requested" ||
          event.type === "model.output.delta",
      )
    ) {
      throw new ApplicationError(
        "validation",
        "assistant_sample_items_invalid",
      );
    }
    return "empty";
  }
  requireBoundedContent(input.output);
  for (const content of input.completedAssistantItems)
    requireBoundedContent(content);
  if (input.completedAssistantItems.join("") !== input.output)
    throw new ApplicationError("validation", "assistant_sample_items_invalid");
  return "content";
}
