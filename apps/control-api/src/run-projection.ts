import type {
  GetRunPlanResponse,
  RunEventExtension,
  RunEventView,
  RunEventViewMode,
  RunPlanView,
  RunView,
} from "@crewon/contracts";
import type { RunLifecycleEvent, RunPlan, RunState } from "@crewon/domain";

const MAX_TOOL_PREVIEW_BYTES = 16 * 1024;
const TOOL_PREVIEW_TRUNCATION_MARKER = "\n… transcript preview truncated …\n";

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
    workflowVersionBinding: state.workflowVersionBinding ?? null,
    goalBinding: state.goalBinding,
    outputRef: state.outputRef,
    failure: state.failure,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    terminalAt: state.terminalAt,
  };
}

export function projectRunPlanSnapshot(state: RunState): GetRunPlanResponse {
  return {
    runId: state.runId,
    eventSequence: state.lastSequence,
    plan:
      state.plan === undefined || state.plan === null
        ? null
        : projectRunPlan(state.plan),
  };
}

function projectRunPlan(plan: RunPlan): RunPlanView {
  return {
    schemaVersion: plan.schemaVersion,
    planId: plan.planId,
    revision: plan.revision,
    explanation: plan.explanation,
    items: plan.items.map((item) => ({
      itemId: item.itemId,
      title: item.title,
      status: item.status,
    })),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
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
    case "run.plan.updated":
      return {
        ...envelope,
        type: event.type,
        data: { plan: projectRunPlan(event.data.plan) },
      };
    case "segment.started":
      return {
        ...envelope,
        type: event.type,
        data: {
          segmentId: event.data.segmentId,
          attempt: event.data.attempt,
        },
      };
    case "model.image.progress":
      return {
        ...envelope,
        type: event.type,
        data: {
          segmentId: event.data.segmentId,
          itemId: event.data.itemId,
          stage: event.data.stage,
        },
      };
    case "model.image.generated":
      return {
        ...envelope,
        type: event.type,
        data: {
          segmentId: event.data.segmentId,
          itemId: event.data.itemId,
          artifactRef: event.data.artifactRef,
          mimeType: event.data.mimeType,
          byteLength: event.data.byteLength,
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
    case "segment.provider_continuation":
      return {
        ...envelope,
        type: event.type,
        data: {
          segmentId: event.data.segmentId,
          sampleIndex: event.data.sampleIndex,
          throughHistorySequence: event.data.throughHistorySequence,
        },
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
    case "model.reasoning.summary":
      throw new Error("run_event_projection_unsupported");
  }
  throw new Error("run_event_projection_unsupported");
}

/** Keeps the immutable audit stream complete while suppressing transient client noise. */
export function projectRunEventForView(
  event: RunLifecycleEvent,
  view: RunEventViewMode,
  extensions: readonly RunEventExtension[] = [],
): RunEventView | null {
  if (
    event.type === "run.plan.updated" &&
    !extensions.includes("run-plan-v1")
  ) {
    return null;
  }
  if (
    view === "client" &&
    event.type === "model.sampling.retry" &&
    event.data.code === "responses_websocket_closed" &&
    event.data.samplingAttempt < event.data.maxRetries
  ) {
    return null;
  }
  if (view === "transcript" && event.type === "tool.requested") {
    const preview = boundedToolPreview(event.data.input);
    return {
      ...projectRunEvent(event),
      type: event.type,
      data: {
        segmentId: event.data.segmentId,
        callId: event.data.callId,
        kind: event.data.kind,
        name: event.data.name,
        inputPreview: preview.text,
        inputTruncated: preview.truncated,
      },
    };
  }
  if (view === "transcript" && event.type === "tool.completed") {
    const preview = boundedToolPreview(event.data.output);
    return {
      ...projectRunEvent(event),
      type: event.type,
      data: {
        segmentId: event.data.segmentId,
        callId: event.data.callId,
        kind: event.data.kind,
        name: event.data.name,
        isError: event.data.isError,
        outputTruncated: event.data.outputTruncated || preview.truncated,
        artifactAvailable: event.data.artifactRef !== null,
        ...(event.data.workspaceChanges === undefined
          ? {}
          : { workspaceChanges: event.data.workspaceChanges }),
        outputPreview: preview.text,
      },
    };
  }
  return projectRunEvent(event);
}

function boundedToolPreview(value: string): {
  text: string;
  truncated: boolean;
} {
  if (byteLength(value) <= MAX_TOOL_PREVIEW_BYTES) {
    return { text: value, truncated: false };
  }
  const entries = [...value].map((text) => ({ text, bytes: byteLength(text) }));
  const contentBudget =
    MAX_TOOL_PREVIEW_BYTES - byteLength(TOOL_PREVIEW_TRUNCATION_MARKER);
  const headBudget = Math.floor(contentBudget / 2);
  const head: string[] = [];
  const tail: string[] = [];
  let headBytes = 0;
  let tailBytes = 0;
  let start = 0;
  let end = entries.length - 1;
  while (start <= end && headBytes + entries[start]!.bytes <= headBudget) {
    head.push(entries[start]!.text);
    headBytes += entries[start]!.bytes;
    start += 1;
  }
  while (
    end >= start &&
    tailBytes + entries[end]!.bytes <= contentBudget - headBytes
  ) {
    tail.unshift(entries[end]!.text);
    tailBytes += entries[end]!.bytes;
    end -= 1;
  }
  return {
    text: `${head.join("")}${TOOL_PREVIEW_TRUNCATION_MARKER}${tail.join("")}`,
    truncated: true,
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
