import {
  parseCanonicalAgentEvent,
  parseProviderCheckpoint,
  type CanonicalAgentEvent,
  type ProviderCheckpoint,
} from "@crewon/contracts/runtime";
import type { RunLifecycleEvent } from "@crewon/domain";

import { canonicalJson } from "./canonical-json.ts";
import { mapAgentEvent } from "./run-execution-support.ts";
import { RunStoreError } from "./run-store-port.ts";
import {
  MAX_WORKFLOW_CONTINUATION_HISTORY_BYTES,
  MAX_WORKFLOW_CONTINUATION_HISTORY_ITEMS,
  type WorkflowContinuationHistoryItem,
  type WorkflowNodeContinuationCheckpoint,
  validateWorkflowNodeContinuationCheckpoint,
} from "./workflow-node-continuation-store-port.ts";

export const MAX_WORKFLOW_RETRIEVED_CONTINUATION_EVENTS = 64;
export const MAX_WORKFLOW_RETRIEVED_CONTINUATION_BYTES = 512 * 1024;
export const MAX_WORKFLOW_RETRIEVED_CONTINUATION_EVENT_BYTES = 64 * 1024;

/** Kernel-private assistant boundary projected into Application-owned semantics. */
export type WorkflowRetrievedAssistantContinuation = Readonly<{
  segmentId: string;
  sequence: number;
  output: string;
  completedAssistantItems: readonly string[];
  checkpoint: ProviderCheckpoint | null;
  providerTurnState: string | null;
}>;

/** Semantic checkpoint fields that a Store may complete with durable authority. */
export type WorkflowRetrievedContinuationNext = Omit<
  WorkflowNodeContinuationCheckpoint,
  | "activeDispatch"
  | "authority"
  | "revision"
  | "terminalCandidate"
  | "updatedAt"
>;

/** Bounded non-terminal provider GET result; it grants no caller-owned authority. */
export type WorkflowRetrievedContinuationPayload = Readonly<{
  events: readonly CanonicalAgentEvent[];
  assistantContinuation: WorkflowRetrievedAssistantContinuation | null;
  next: WorkflowRetrievedContinuationNext;
}>;

/**
 * Deep-validates a retrieved continuation before it crosses the Store boundary.
 * The Store still fences the expected Run, segment, dispatch and prior prefix.
 */
export function validateWorkflowRetrievedContinuationPayload(
  input: unknown,
): WorkflowRetrievedContinuationPayload {
  const value = exactRecord(input);
  exactKeys(value, ["assistantContinuation", "events", "next"]);
  if (
    !Array.isArray(value.events) ||
    value.events.length > MAX_WORKFLOW_RETRIEVED_CONTINUATION_EVENTS
  )
    invalidRetrievedContinuation();
  const events = value.events.map((event) => {
    let parsed: CanonicalAgentEvent;
    try {
      parsed = parseCanonicalAgentEvent(
        event,
        MAX_WORKFLOW_RETRIEVED_CONTINUATION_EVENT_BYTES,
      );
      projectWorkflowRetrievedContinuationEvent(
        parsed,
        1,
        "retrieved-event-validation",
        "2026-01-01T00:00:00.000Z",
        () => `sha256:${"0".repeat(64)}`,
      );
    } catch {
      invalidRetrievedContinuation();
    }
    if (parsed.type === "segment.completed" || parsed.type === "segment.failed")
      invalidRetrievedContinuation();
    return structuredClone(parsed);
  });
  const assistantContinuation =
    value.assistantContinuation === null
      ? null
      : validateAssistantContinuation(value.assistantContinuation);
  const next = validateNext(value.next);
  const toolRequested = events.filter(
    (event) => event.type === "tool.requested",
  );
  if (
    (assistantContinuation === null && toolRequested.length === 0) ||
    (assistantContinuation !== null &&
      (next.segmentId !== assistantContinuation.segmentId ||
        canonicalJson(next.providerCheckpoint) !==
          canonicalJson(assistantContinuation.checkpoint) ||
        next.providerTurnState !== assistantContinuation.providerTurnState)) ||
    events.some(
      (event, index) =>
        event.runId !== events[0]?.runId ||
        event.segmentId !== next.segmentId ||
        (index > 0 && event.sequence <= events[index - 1]!.sequence) ||
        (assistantContinuation !== null &&
          event.sequence >= assistantContinuation.sequence),
    )
  )
    invalidRetrievedContinuation();
  const payload = structuredClone({ events, assistantContinuation, next });
  if (
    new TextEncoder().encode(canonicalJson(payload)).byteLength >
    MAX_WORKFLOW_RETRIEVED_CONTINUATION_BYTES
  )
    invalidRetrievedContinuation();
  return payload;
}

/** Canonical projection used by Stores when atomically appending retrieved events. */
export function projectWorkflowRetrievedContinuationEvent(
  event: CanonicalAgentEvent,
  runSequence: number,
  eventId: string,
  occurredAt: string,
  checkpointDigest: (checkpoint: unknown) => string,
): RunLifecycleEvent {
  return mapAgentEvent(
    event,
    runSequence,
    eventId,
    occurredAt,
    checkpointDigest,
  );
}

function validateAssistantContinuation(
  input: unknown,
): WorkflowRetrievedAssistantContinuation {
  const value = exactRecord(input);
  exactKeys(value, [
    "checkpoint",
    "completedAssistantItems",
    "output",
    "providerTurnState",
    "segmentId",
    "sequence",
  ]);
  if (
    !boundedId(value.segmentId) ||
    !positiveInteger(value.sequence) ||
    typeof value.output !== "string" ||
    !Array.isArray(value.completedAssistantItems) ||
    !value.completedAssistantItems.every((item) => typeof item === "string") ||
    value.completedAssistantItems.join("") !== value.output ||
    (value.providerTurnState !== null &&
      typeof value.providerTurnState !== "string")
  )
    invalidRetrievedContinuation();
  let checkpoint: ProviderCheckpoint | null;
  try {
    checkpoint =
      value.checkpoint === null
        ? null
        : structuredClone(parseProviderCheckpoint(value.checkpoint));
  } catch {
    invalidRetrievedContinuation();
  }
  return structuredClone({
    segmentId: value.segmentId,
    sequence: value.sequence,
    output: value.output,
    completedAssistantItems: value.completedAssistantItems,
    checkpoint,
    providerTurnState: value.providerTurnState,
  }) as WorkflowRetrievedAssistantContinuation;
}

function validateNext(input: unknown): WorkflowRetrievedContinuationNext {
  const value = exactRecord(input);
  exactKeys(value, [
    "history",
    "modelSampleIndex",
    "providerCheckpoint",
    "providerTurnState",
    "schemaVersion",
    "segmentId",
    "toolRoundsConsumed",
  ]);
  const validated = validateWorkflowNodeContinuationCheckpoint({
    ...value,
    authority: {
      tenantId: "validation",
      runId: "validation",
      workItemId: "validation",
      leaseEpoch: 1,
      nodeId: "validation",
      nodeKind: "agent",
      claimId: "validation",
      claimEpoch: 1,
      agentVersionId: "validation",
      attempt: { stepId: "validation", attemptId: "validation" },
    },
    activeDispatch: null,
    terminalCandidate: null,
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  return {
    schemaVersion: validated.schemaVersion,
    segmentId: validated.segmentId,
    modelSampleIndex: validated.modelSampleIndex,
    toolRoundsConsumed: validated.toolRoundsConsumed,
    providerCheckpoint: validated.providerCheckpoint,
    providerTurnState: validated.providerTurnState,
    history: validated.history as readonly WorkflowContinuationHistoryItem[],
  };
}

function exactRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalidRetrievedContinuation();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    invalidRetrievedContinuation();
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  )
    invalidRetrievedContinuation();
}

function boundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).byteLength <= 512
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function invalidRetrievedContinuation(): never {
  throw new RunStoreError("workflow_retrieved_continuation_invalid");
}
