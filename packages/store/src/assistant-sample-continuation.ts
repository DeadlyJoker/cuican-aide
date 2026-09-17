import { isEmptyProviderContinuationSource } from "@crewon/domain";
import { isDeepStrictEqual } from "node:util";
import {
  RunStoreError,
  type CommitAssistantSampleContinuationInput,
  type CommitRunResult,
} from "@crewon/application";
import type { RunState, RunStepState, RunAttemptState } from "@crewon/domain";

/** Empty samples advance execution authority without inventing model history. */
export function validateAssistantSampleContinuationBody(
  input: CommitAssistantSampleContinuationInput,
  runId: string,
): void {
  const completed = input.commit.events.at(-1);
  if (completed?.type !== "segment.provider_continuation") invalid();
  const empty = completed.data.emptyContinuation !== undefined;
  if (
    empty &&
    (!isEmptyProviderContinuationSource(completed.data.emptyContinuation) ||
      completed.data.emptyContinuation.stepId !== input.attempt.stepId ||
      completed.data.emptyContinuation.attemptId !== input.attempt.attemptId ||
      completed.data.emptyContinuation.contextRevision !==
        input.modelState.contextRevision)
  )
    invalid();
  const first = input.history.items[0];
  const head = input.history.expectedLastSequence + input.history.items.length;
  const toolEvents = input.commit.events.filter(
    (event) => event.type === "tool.requested",
  );
  const toolItems = input.history.items.filter(
    (item) => item.type === "tool_call",
  );
  if (empty) {
    if (
      input.history.items.length !== 0 ||
      input.history.expectedLastSequence < 1 ||
      input.commit.events.some(
        (event) =>
          event.type === "tool.requested" ||
          event.type === "model.output.delta",
      )
    )
      invalid();
  } else if (
    first?.type !== "message" ||
    first.role !== "assistant" ||
    first.source !== "assistant_completion"
  )
    invalid();
  if (
    input.history.items.some(
      (item, index) =>
        (item.type !== "message" && item.type !== "tool_call") ||
        item.tenantId !== input.commit.tenantId ||
        item.threadId !== input.modelState.threadId ||
        item.runId !== runId ||
        item.segmentId !== completed.data.segmentId ||
        item.sequence !== input.history.expectedLastSequence + index + 1 ||
        (item.type === "message" &&
          (item.role !== "assistant" ||
            item.source !== "assistant_completion" ||
            input.history.items
              .slice(0, index)
              .some((prior) => prior.type === "tool_call"))),
    ) ||
    toolItems.length !== toolEvents.length ||
    toolItems.some((item, index) => {
      const event = toolEvents[index];
      return (
        event === undefined ||
        item.segmentId !== event.data.segmentId ||
        item.callId !== event.data.callId ||
        item.kind !== event.data.kind ||
        item.name !== event.data.name ||
        item.input !== event.data.input
      );
    }) ||
    input.commit.events
      .slice(0, -1)
      .some((event) => event.type === "segment.provider_continuation") ||
    completed.data.sampleIndex !== input.sampleIndex ||
    completed.data.throughHistorySequence !== head ||
    input.attempt.finishedAt !== completed.occurredAt ||
    input.commit.workItems.length !== 0 ||
    input.modelState.tenantId !== input.commit.tenantId ||
    input.modelState.throughHistorySequence !== head
  )
    invalid();
  if (
    input.continuation !== null &&
    (input.continuation.tenantId !== input.commit.tenantId ||
      input.continuation.threadId !== input.modelState.threadId ||
      input.continuation.agentVersionId !== input.modelState.agentVersionId ||
      input.continuation.adapterName !== input.modelState.adapterName ||
      input.continuation.adapterVersion !== input.modelState.adapterVersion ||
      input.continuation.modelId !== input.modelState.modelId ||
      input.continuation.throughHistorySequence !== head ||
      input.continuation.contextRevision !== input.modelState.contextRevision ||
      input.continuation.updatedAt !== input.attempt.finishedAt)
  )
    invalid();
}

export function validateAssistantSampleAuthority(
  input: Omit<CommitAssistantSampleContinuationInput, "sampleIndex">,
  run: RunState | null,
  step: RunStepState,
): void {
  if (
    run === null ||
    run.tenantId !== input.commit.tenantId ||
    run.runId !== input.commit.events[0]?.identity.runId ||
    run.threadId !== input.modelState.threadId ||
    run.agentVersionId !== input.modelState.agentVersionId ||
    run.status !== "running" ||
    run.cancelRequested ||
    step.kind !== "model"
  )
    invalid();
}

export function validateAssistantSampleReplay(
  input: Omit<CommitAssistantSampleContinuationInput, "sampleIndex">,
  run: CommitRunResult,
  step: RunStepState,
  attempt: RunAttemptState,
): void {
  validateAssistantSampleAuthority(input, run.state, step);
  if (
    !isDeepStrictEqual(run.events, input.commit.events) ||
    attempt.workItemId !== input.lease.workItemId ||
    attempt.leaseEpoch !== input.lease.leaseEpoch ||
    attempt.terminalAt !== input.attempt.finishedAt ||
    attempt.checkpointDigest !== input.attempt.checkpointDigest ||
    (input.continuation !== null &&
      !isDeepStrictEqual(
        attempt.providerCheckpoint,
        input.continuation.checkpoint,
      ))
  )
    invalid();
}

function invalid(): never {
  throw new RunStoreError("assistant_sample_continuation_mismatch");
}

export function isEmptyAssistantSample(
  input: Omit<CommitAssistantSampleContinuationInput, "sampleIndex">,
): boolean {
  const event = input.commit.events.at(-1);
  return (
    event?.type === "segment.provider_continuation" &&
    event.data.emptyContinuation !== undefined
  );
}
