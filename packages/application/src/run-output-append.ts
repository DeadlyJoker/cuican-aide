import {
  parseCanonicalAgentEvent,
  type CanonicalAgentEvent,
} from "@crewon/contracts";
import type { RunState } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { WorkItemClaim } from "./durable-queue-port.ts";
import type {
  AppendRunOutputEventsInput,
  RunOutputAppendEntry,
} from "./run-output-store-port.ts";
import {
  executionIdempotency,
  leaseInput,
  mapAgentEvent,
} from "./run-execution-support.ts";

export function prepareRunOutputAppendInput(
  input: Readonly<{
    state: RunState;
    claim: WorkItemClaim;
    events: readonly CanonicalAgentEvent[];
    occurredAt: string;
    nextEventId: () => string;
    nextOutboxId: () => string;
  }>,
): AppendRunOutputEventsInput {
  if (input.events.length < 1 || input.events.length > 32)
    throw new ApplicationError("validation", "run_output_batch_invalid");
  const entries: RunOutputAppendEntry[] = input.events.map(
    (canonical, index) => {
      parseCanonicalAgentEvent(canonical);
      if (
        canonical.runId !== input.state.runId ||
        canonical.type !== "model.output.delta"
      )
        throw new ApplicationError("validation", "run_output_batch_invalid");
      const event = mapAgentEvent(
        canonical,
        input.state.lastSequence + index + 1,
        input.nextEventId(),
        input.occurredAt,
        () => {
          throw new ApplicationError(
            "validation",
            "run_output_checkpoint_invalid",
          );
        },
      );
      if (event.type !== "model.output.delta")
        throw new ApplicationError("validation", "run_output_batch_invalid");
      return {
        event,
        idempotency: executionIdempotency(
          input.state,
          input.claim.workItem,
          `agent:${canonical.segmentId}:${canonical.sequence}`,
          { kind: "agent.event", event: canonical },
        ),
      };
    },
  );
  return {
    tenantId: input.state.tenantId,
    runId: input.state.runId,
    lease: leaseInput(input.claim),
    expectedRevision: input.state.revision,
    entries,
    notification: {
      messageId: input.nextOutboxId(),
      createdAt: input.occurredAt,
    },
  };
}
