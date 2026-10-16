import type { CommitRunInput } from "@crewon/application";
import type { RunState, RunLifecycleEvent } from "@crewon/domain";
/** Construct the existing cancellation command; physical stores retain their own transaction and locks. */
export function prepareWorkflowChildCancellation(
  input: {
    child: RunState;
    actorId: string;
    idempotency: CommitRunInput["idempotency"];
  },
  now: string,
  nextId: () => string,
): CommitRunInput {
  const { child } = input;
  const event: RunLifecycleEvent = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: child.runId },
    eventId: nextId(),
    sequence: child.lastSequence + 1,
    occurredAt: now,
    type: "run.cancel.requested",
    data: { actorId: input.actorId },
  };
  return {
    tenantId: child.tenantId,
    expectedRevision: child.revision,
    idempotency: input.idempotency,
    events: [event],
    workItems: [],
    outbox: [
      {
        messageId: nextId(),
        tenantId: child.tenantId,
        runId: child.runId,
        topic: "run.updated",
        payload: {
          eventId: event.eventId,
          eventType: event.type,
          throughSequence: event.sequence,
        },
        createdAt: now,
      },
    ],
  };
}
