import type { RunExecutionService, WorkItemClaim } from "@crewon/application";
import type { CanonicalAgentEvent } from "@crewon/contracts";

/** Keep model-history and terminal events on their existing authoritative commit paths. */
export function recordWorkerAgentEvent(
  execution: RunExecutionService,
  claim: WorkItemClaim,
  event: CanonicalAgentEvent,
) {
  return event.type === "segment.started" || event.type === "usage.recorded"
    ? execution.recordProgressEvent(claim, { ...event, type: event.type })
    : execution.recordAgentEvent(claim, event);
}
