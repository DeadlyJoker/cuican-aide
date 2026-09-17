import type {
  ModelHistoryItem,
  RunState,
  RunLifecycleEvent,
} from "@crewon/domain";
import { TURN_ABORTED_HISTORY_MARKER } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { DomainStore } from "./domain-store-port.ts";
import type { WorkItemClaim } from "./durable-queue-port.ts";
import type { RunAttemptIdentity } from "./run-execution-store-port.ts";
import type { ModelHistoryAppend } from "./model-history-store-port.ts";
import {
  loadRunExecutionProgress,
  type RunProgressLoadControl,
} from "./run-execution-progress-loader.ts";

export type RunCancellationHistoryResult =
  | Readonly<{ kind: "ready"; history: ModelHistoryAppend }>
  | Readonly<{ kind: "deferred"; throughSequence: number }>;

/** Settle pending calls in canonical order after bounded, resumable preparation. */
export async function prepareRunCancellationHistory(input: {
  store: DomainStore;
  claim: WorkItemClaim;
  state: RunState;
  attempt: RunAttemptIdentity | null;
  occurredAt: string;
  nextItemId(): string;
  digest(content: string): string;
  control?: RunProgressLoadControl;
}): Promise<RunCancellationHistoryResult> {
  const progress = await loadRunExecutionProgress({
    store: input.store,
    claim: input.claim,
    run: input.state,
    purpose: "cancel",
    query: input.control?.query ?? (async (_key, operation) => operation()),
    onProgress: input.control?.onProgress ?? (async () => {}),
    ...(input.control?.budget === undefined
      ? {}
      : { budget: input.control.budget }),
    onInvalid: (code) => {
      throw new ApplicationError("internal", code);
    },
  });
  if (progress.kind === "deferred") return progress;
  const head = await input.store.loadModelHistoryHead({
    tenantId: input.state.tenantId,
    threadId: input.state.threadId,
  });
  if (head === null)
    throw new ApplicationError("notFound", "model_history_not_found");
  const { state, attempt, occurredAt } = input;
  const pending = new Map(
    progress.progress.pendingTools.map((event) => [event.data.callId, event]),
  );
  const items: ModelHistoryItem[] = [];
  let sequence = head.lastSequence;
  for (const requested of pending.values()) {
    sequence += 1;
    items.push({
      schemaVersion: "crewon.model-history-item.v0",
      itemId: input.nextItemId(),
      tenantId: state.tenantId,
      threadId: state.threadId,
      sequence,
      runId: state.runId,
      segmentId: requested.data.segmentId,
      createdAt: occurredAt,
      type: "tool_result",
      kind: requested.data.kind,
      callId: requested.data.callId,
      output: abortedToolOutput(requested, occurredAt),
      isError: true,
      status: "aborted",
    });
  }

  const markerSegmentId =
    attempt === null
      ? (pending.values().next().value?.data.segmentId ?? null)
      : `segment:${attempt.attemptId}`;
  sequence += 1;
  items.push({
    schemaVersion: "crewon.model-history-item.v0",
    itemId: input.nextItemId(),
    tenantId: state.tenantId,
    threadId: state.threadId,
    sequence,
    runId: state.runId,
    segmentId: markerSegmentId,
    createdAt: occurredAt,
    type: "message",
    role: "user",
    source: "turn_aborted",
    content: TURN_ABORTED_HISTORY_MARKER,
    contentDigest: input.digest(TURN_ABORTED_HISTORY_MARKER),
  });
  return {
    kind: "ready",
    history: { expectedLastSequence: head.lastSequence, items },
  };
}

function abortedToolOutput(
  requested: Extract<RunLifecycleEvent, { type: "tool.requested" }>,
  abortedAt: string,
): string {
  const elapsedSeconds = Math.max(
    0,
    (Date.parse(abortedAt) - Date.parse(requested.occurredAt)) / 1_000,
  );
  const elapsed = elapsedSeconds.toFixed(1);
  return requested.data.kind === "function" &&
    (requested.data.name === "shell_command" ||
      requested.data.name === "unified_exec")
    ? `Wall time: ${elapsed} seconds\naborted by user`
    : `aborted by user after ${elapsed}s`;
}
