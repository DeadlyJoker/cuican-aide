import type {
  CommitThreadGoalMutationResult,
  MessageRecord,
} from "@crewon/application";
import type {
  MessageView,
  ThreadEventView,
  ThreadGoalEventView,
  ThreadGoalMutationResponse,
  ThreadGoalView,
  ThreadView,
} from "@crewon/contracts";
import {
  projectPublicThreadGoalEvent,
  type ThreadGoal,
  type ThreadGoalEvent,
  type ThreadLifecycleEvent,
  type ThreadState,
} from "@crewon/domain";

import { projectRun } from "./run-projection.ts";

export function projectThread(state: ThreadState): ThreadView {
  return {
    threadId: state.threadId,
    title: state.title,
    status: state.status,
    revision: state.revision,
    lastMessageSequence: state.lastMessageSequence,
    forkedFromThreadId: state.forkedFromThreadId,
    forkedThroughHistorySequence: state.forkedThroughHistorySequence,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    archivedAt: state.archivedAt,
    deletedAt: state.deletedAt,
  };
}

export function projectMessage(message: MessageRecord): MessageView {
  const proposedPlan = message.proposedPlan ?? null;
  return {
    messageId: message.messageId,
    threadId: message.threadId,
    sequence: message.sequence,
    role: message.role,
    content: message.content,
    proposedPlan:
      proposedPlan === null
        ? null
        : {
            schemaVersion: proposedPlan.schemaVersion,
            planId: proposedPlan.planId,
            threadId: proposedPlan.threadId,
            runId: proposedPlan.runId,
            messageId: proposedPlan.messageId,
            content: proposedPlan.content,
            createdAt: proposedPlan.createdAt,
          },
    createdAt: message.createdAt,
  };
}

export function projectThreadEvent(
  event: ThreadLifecycleEvent,
): ThreadEventView {
  if (event.type === "thread.rolled_back") {
    return {
      threadId: event.identity.threadId,
      eventId: event.eventId,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      type: event.type,
      requestedTurns: event.data.requestedTurns,
      removedTurns: event.data.removedTurns,
    };
  }
  return {
    schemaVersion: event.schemaVersion,
    threadId: event.identity.threadId,
    eventId: event.eventId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    type: event.type,
  };
}

export function projectThreadGoal(goal: ThreadGoal): ThreadGoalView {
  return {
    threadId: goal.threadId,
    goalId: goal.goalId,
    revision: goal.revision,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

export function projectThreadGoalMutation(
  result: CommitThreadGoalMutationResult,
): ThreadGoalMutationResponse {
  return {
    disposition: result.disposition,
    goal:
      result.goalState === null ? null : projectThreadGoal(result.goalState),
    canceledRun:
      result.canceledRunState === null
        ? null
        : projectRun(result.canceledRunState),
    retainedRun:
      result.retainedRun === null
        ? null
        : projectRun(result.retainedRun.runState),
    continuationRun:
      result.continuation === null
        ? null
        : projectRun(result.continuation.runState),
  };
}

export function projectThreadGoalEvent(
  event: ThreadGoalEvent,
): ThreadGoalEventView {
  return projectPublicThreadGoalEvent(event);
}
