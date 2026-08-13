import type { DomainStore } from "@crewon/application";
import type { KernelAgentEvent } from "@crewon/agent-kernel";
import type { RunLifecycleEvent, RunState } from "@crewon/domain";

export async function loadPendingToolEventsForSegment(input: {
  store: Pick<DomainStore, "listRunEvents">;
  run: RunState;
  segmentId: string;
}): Promise<
  Readonly<{
    events: readonly Extract<KernelAgentEvent, { type: "tool.requested" }>[];
    requestedCallIds: readonly string[];
    completedCallIds: readonly string[];
    lastSegmentSequence: number;
  }>
> {
  const all: RunLifecycleEvent[] = [];
  let cursor = 0;
  while (cursor < input.run.lastSequence) {
    const page = await input.store.listRunEvents(
      { tenantId: input.run.tenantId, runId: input.run.runId },
      cursor,
      Math.min(250, input.run.lastSequence - cursor),
    );
    if (page.length === 0) throw new Error("run_event_history_incomplete");
    all.push(...page);
    cursor = page.at(-1)!.sequence;
  }
  const pending = new Map<
    string,
    Extract<RunLifecycleEvent, { type: "tool.requested" }>
  >();
  const requested = new Map<string, number>();
  const completed = new Set<string>();
  let lastSegmentSequence = 0;
  for (const event of all) {
    if (
      "segmentId" in event.data &&
      event.data.segmentId === input.segmentId &&
      "segmentSequence" in event.data
    )
      lastSegmentSequence = Math.max(
        lastSegmentSequence,
        event.data.segmentSequence,
      );
    if (
      event.type === "tool.requested" &&
      event.data.segmentId === input.segmentId
    ) {
      pending.set(event.data.callId, event);
      requested.set(event.data.callId, event.data.segmentSequence);
    } else if (
      event.type === "tool.completed" &&
      event.data.segmentId === input.segmentId
    ) {
      pending.delete(event.data.callId);
      completed.add(event.data.callId);
    }
  }
  return {
    events: [...pending.values()]
      .sort((a, b) => a.data.segmentSequence - b.data.segmentSequence)
      .map((event) => ({
        schemaVersion: "crewon.agent-event.v0",
        runId: input.run.runId,
        segmentId: event.data.segmentId,
        sequence: event.data.segmentSequence,
        type: "tool.requested",
        data: {
          callId: event.data.callId,
          kind: event.data.kind,
          name: event.data.name,
          input: event.data.input,
        },
      })),
    requestedCallIds: [...requested.entries()]
      .sort((left, right) => left[1] - right[1])
      .map(([callId]) => callId),
    completedCallIds: [...completed].sort(
      (left, right) =>
        (requested.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (requested.get(right) ?? Number.MAX_SAFE_INTEGER),
    ),
    lastSegmentSequence,
  };
}

export function workflowContinuationHistoryStart(
  history: readonly import("@crewon/agent-kernel").AgentHistoryItem[],
  requestedCallIds: readonly string[],
): number {
  const callIds = new Set(requestedCallIds);
  const firstToolCall = history.findIndex(
    (item) => item.type === "tool_call" && callIds.has(item.callId),
  );
  if (firstToolCall < 0)
    throw new Error("workflow_tool_approval_pending_call_missing");
  const prior = history[firstToolCall - 1];
  return prior?.type === "message" && prior.role === "assistant"
    ? firstToolCall - 1
    : firstToolCall;
}
