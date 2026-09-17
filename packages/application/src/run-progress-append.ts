import {
  parseCanonicalAgentEvent,
  type CanonicalAgentEvent,
} from "@crewon/contracts";
import type { RunState } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { WorkItemClaim } from "./durable-queue-port.ts";
import type {
  AppendRunProgressEventsInput,
  RunProgressEvent,
} from "./run-output-store-port.ts";
import {
  executionIdempotency,
  leaseInput,
  mapAgentEvent,
} from "./run-execution-support.ts";

export type ProgressAgentEvent = CanonicalAgentEvent &
  Readonly<{ type: "segment.started" | "usage.recorded" }>;

/** These observations do not append model history or close an execution boundary. */
export function prepareRunProgressAppendInput(input: {
  state: RunState;
  claim: WorkItemClaim;
  canonical: ProgressAgentEvent;
  occurredAt: string;
  eventId: string;
  notificationId: string;
}): AppendRunProgressEventsInput {
  const { state, canonical, claim } = input;
  parseCanonicalAgentEvent(canonical);
  if (state.cancelRequested)
    throw new ApplicationError("conflict", "execution_cancel_pending");
  if (state.status !== "running")
    throw new ApplicationError("conflict", "run_not_running");
  if (
    canonical.runId !== state.runId ||
    (canonical.type !== "segment.started" &&
      canonical.type !== "usage.recorded")
  )
    throw new ApplicationError("validation", "run_progress_event_invalid");
  const mapped = mapAgentEvent(
    canonical,
    state.lastSequence + 1,
    input.eventId,
    input.occurredAt,
    () => {
      throw new ApplicationError(
        "validation",
        "run_progress_checkpoint_invalid",
      );
    },
  );
  if (mapped.type !== "segment.started" && mapped.type !== "usage.recorded")
    throw new ApplicationError("validation", "run_progress_event_invalid");
  const event: RunProgressEvent = mapped;
  return {
    tenantId: state.tenantId,
    runId: state.runId,
    lease: leaseInput(claim),
    expectedRevision: state.revision,
    entries: [
      {
        event,
        idempotency: executionIdempotency(
          state,
          claim.workItem,
          `agent:${canonical.segmentId}:${canonical.sequence}`,
          { kind: "agent.event", event: canonical },
        ),
      },
    ],
    notification: {
      messageId: input.notificationId,
      createdAt: input.occurredAt,
    },
  };
}
