import { createHash } from "node:crypto";

import {
  validateThreadGoalEvent,
  validateThreadGoalEventPageBoundary,
  type ThreadGoal,
  type ThreadGoalEvent,
} from "@crewon/domain";

import { RunStoreError } from "@crewon/application";

import { stableJson } from "./store-invariants.ts";

export function validateStoredThreadGoalEventPage(
  events: readonly ThreadGoalEvent[],
  locator: Readonly<{ tenantId: string; threadId: string }>,
  afterSequence: number,
): void {
  try {
    validateThreadGoalEventPageBoundary(events, {
      tenantId: locator.tenantId,
      threadId: locator.threadId,
      afterSequence,
    });
  } catch (error) {
    throw new RunStoreError("stored_goal_event_page_invalid", { cause: error });
  }
}

export function createThreadGoalEvent(input: {
  current: ThreadGoal | null;
  next: ThreadGoal | null;
  lastSequence: number;
  occurredAt: string;
  tenantId: string;
  threadId: string;
}): ThreadGoalEvent | null {
  if (stableJson(input.current) === stableJson(input.next)) return null;
  if (
    !Number.isSafeInteger(input.lastSequence) ||
    input.lastSequence < 0 ||
    input.lastSequence === Number.MAX_SAFE_INTEGER
  ) {
    throw new RunStoreError("goal_event_sequence_invalid");
  }
  if (input.current === null && input.next === null) return null;
  const sequence = input.lastSequence + 1;
  const base = {
    schemaVersion: "crewon.thread-goal-event.v0" as const,
    tenantId: input.tenantId,
    threadId: input.threadId,
    sequence,
    occurredAt: input.occurredAt,
  };
  const content =
    input.next === null
      ? {
          ...base,
          type: "goal.cleared" as const,
          data: {
            previousGoalId: input.current!.goalId,
            previousRevision: input.current!.revision,
          },
        }
      : {
          ...base,
          type: "goal.updated" as const,
          data: { goal: input.next },
        };
  const event: ThreadGoalEvent = {
    ...content,
    eventId: `sha256:${createHash("sha256")
      .update(stableJson(content))
      .digest("hex")}`,
  };
  try {
    validateThreadGoalEvent(event);
  } catch (error) {
    throw new RunStoreError("goal_event_invalid", { cause: error });
  }
  return event;
}
