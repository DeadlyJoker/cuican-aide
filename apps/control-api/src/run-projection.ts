import type {
  RunEventView,
  RunEventViewMode,
  RunView,
} from "@crewon/contracts";
import type { RunLifecycleEvent, RunState } from "@crewon/domain";

export function projectRun(state: RunState): RunView {
  return {
    runId: state.runId,
    threadId: state.threadId,
    status: state.status,
    revision: state.revision,
    lastSequence: state.lastSequence,
    cancelRequested: state.cancelRequested,
    waitingApproval:
      state.waitingApproval === null
        ? null
        : { approvalId: state.waitingApproval.approvalId },
    collaborationMode: state.collaborationMode,
    purpose: state.purpose ?? "turn",
    goalBinding: state.goalBinding,
    outputRef: state.outputRef,
    failure: state.failure,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    terminalAt: state.terminalAt,
  };
}

export function projectRunEvent(event: RunLifecycleEvent): RunEventView {
  const envelope = {
    eventId: event.eventId,
    runId: event.identity.runId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
  };
  switch (event.type) {
    case "run.created":
      return {
        ...envelope,
        type: event.type,
        data: { threadId: event.data.threadId },
      };
    case "run.started":
      return { ...envelope, type: event.type, data: {} };
    case "run.approval.required":
      return {
        ...envelope,
        type: event.type,
        data: { approvalId: event.data.approvalId },
      };
    case "run.resumed":
    case "run.suspended":
    case "run.canceled":
      return {
        ...envelope,
        type: event.type,
        data: { reasonCode: event.data.reasonCode },
      };
    case "run.reconciliation.required":
    case "run.cancel.requested":
      return { ...envelope, type: event.type, data: {} };
    case "run.completed":
      return {
        ...envelope,
        type: event.type,
        data: { outputRef: event.data.outputRef },
      };
    case "run.failed":
      return {
        ...envelope,
        type: event.type,
        data: {
          code: event.data.code,
          retryable: event.data.retryable,
        },
      };
    case "run.goal.accounting.updated":
      return {
        ...envelope,
        type: event.type,
        data: {
          goalId: event.data.next.attribution?.goalId ?? null,
          goalRevision: event.data.next.attribution?.goalRevision ?? null,
          steeringPending: event.data.next.pendingSteering !== null,
        },
      };
    case "run.goal.steering.consumed":
      return { ...envelope, type: event.type, data: {} };
    case "segment.started":
      return {
        ...envelope,
        type: event.type,
        data: {
          segmentId: event.data.segmentId,
          attempt: event.data.attempt,
        },
      };
    case "model.output.delta":
      return {
        ...envelope,
        type: event.type,
        data: {
          segmentId: event.data.segmentId,
          delta: event.data.delta,
        },
      };
    case "model.sampling.retry":
      return {
        ...envelope,
        type: event.type,
        data: {
          segmentId: event.data.segmentId,
          samplingAttempt: event.data.samplingAttempt,
          maxRetries: event.data.maxRetries,
          code: event.data.code,
          discardedOutput: event.data.discardedOutput,
        },
      };
    case "model.transport.fallback":
      return {
        ...envelope,
        type: event.type,
        data: {
          segmentId: event.data.segmentId,
          fromTransport: event.data.fromTransport,
          toTransport: event.data.toTransport,
          code: event.data.code,
          discardedOutput: event.data.discardedOutput,
        },
      };
    case "usage.recorded":
      return {
        ...envelope,
        type: event.type,
        data: {
          segmentId: event.data.segmentId,
          inputTokens: event.data.inputTokens,
          outputTokens: event.data.outputTokens,
          totalTokens: event.data.totalTokens,
        },
      };
    case "rate_limit.updated":
      return {
        ...envelope,
        type: event.type,
        data: {
          segmentId: event.data.segmentId,
          snapshot: event.data.snapshot,
        },
      };
    case "tool.requested":
      return {
        ...envelope,
        type: event.type,
        data: {
          segmentId: event.data.segmentId,
          callId: event.data.callId,
          kind: event.data.kind,
          name: event.data.name,
        },
      };
    case "tool.completed":
      return {
        ...envelope,
        type: event.type,
        data: {
          segmentId: event.data.segmentId,
          callId: event.data.callId,
          kind: event.data.kind,
          name: event.data.name,
          isError: event.data.isError,
          outputTruncated: event.data.outputTruncated,
          artifactAvailable: event.data.artifactRef !== null,
        },
      };
    case "context.compacted":
      return {
        ...envelope,
        type: event.type,
        data: {
          mode: event.data.mode,
          replacesThroughSequence: event.data.replacesThroughSequence,
          inputTokens: event.data.inputTokens,
          outputTokens: event.data.outputTokens,
          totalTokens: event.data.totalTokens,
        },
      };
    case "segment.checkpointed":
    case "segment.completed":
      return {
        ...envelope,
        type: event.type,
        data: { segmentId: event.data.segmentId },
      };
    case "segment.failed":
      return {
        ...envelope,
        type: event.type,
        data: {
          segmentId: event.data.segmentId,
          code: event.data.code,
          retryable: event.data.retryable,
        },
      };
    case "message.completed":
      return {
        ...envelope,
        type: event.type,
        data: {
          messageId: event.data.messageId,
          messageSequence: event.data.messageSequence,
          role: event.data.role,
        },
      };
    case "plan.proposed":
      return {
        ...envelope,
        type: event.type,
        data: {
          planId: event.data.planId,
          messageId: event.data.messageId,
          messageSequence: event.data.messageSequence,
        },
      };
  }
}

/** Keeps the immutable audit stream complete while suppressing transient client noise. */
export function projectRunEventForView(
  event: RunLifecycleEvent,
  view: RunEventViewMode,
): RunEventView | null {
  if (
    view === "client" &&
    event.type === "model.sampling.retry" &&
    event.data.code === "responses_websocket_closed" &&
    event.data.samplingAttempt < event.data.maxRetries
  ) {
    return null;
  }
  return projectRunEvent(event);
}
