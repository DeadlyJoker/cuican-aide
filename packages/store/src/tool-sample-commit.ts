import { createHash } from "node:crypto";
import { parseProviderCheckpoint } from "@crewon/contracts";
import { RunStoreError, type CommitToolSampleInput } from "@crewon/application";
import type { RunState, RunStepState, RunAttemptState } from "@crewon/domain";
import {
  stableJson,
  validateCommitInput,
  validateCompleteRunAttemptInput,
  validateQueueLease,
  validateThreadModelState,
} from "./store-invariants.ts";

/** Correlate every persisted Tool request and checkpoint with its exact history boundary. */
export function validateToolSampleCommit(input: CommitToolSampleInput): string {
  const runId = validateCommitInput(input.commit);
  validateQueueLease(
    input.lease,
    input.lease.workItemId,
    "work_item_id_invalid",
  );
  validateCompleteRunAttemptInput({
    tenantId: input.commit.tenantId,
    runId,
    lease: input.lease,
    attempt: input.attempt,
  });
  validateThreadModelState(input.modelState);
  const events = input.commit.events;
  const completed = events.at(-1);
  if (
    completed?.type !== "segment.completed" ||
    events.length > 256 ||
    input.commit.workItems.length !== 0
  )
    invalid();
  const segmentId = completed.data.segmentId;
  let segmentSequence = 0;
  for (const event of events) {
    if (
      !("segmentId" in event.data) ||
      event.data.segmentId !== segmentId ||
      !("segmentSequence" in event.data) ||
      event.data.segmentSequence <= segmentSequence ||
      event.occurredAt !== input.attempt.finishedAt
    )
      invalid();
    segmentSequence = event.data.segmentSequence;
    if (
      event !== completed &&
      ![
        "tool.requested",
        "usage.recorded",
        "model.reasoning.summary",
        "segment.checkpointed",
      ].includes(event.type)
    )
      invalid();
  }
  const toolEvents = events.filter((event) => event.type === "tool.requested");
  const toolItems = input.history.items.filter(
    (item) => item.type === "tool_call",
  );
  if (
    toolEvents.length < 1 ||
    toolEvents.length > 16 ||
    toolEvents.length !== toolItems.length
  )
    invalid();
  let sawTool = false;
  for (const [index, item] of input.history.items.entries()) {
    if (
      item.tenantId !== input.commit.tenantId ||
      item.runId !== runId ||
      item.threadId !== input.modelState.threadId ||
      item.segmentId !== segmentId ||
      item.sequence !== input.history.expectedLastSequence + index + 1 ||
      item.createdAt !== input.attempt.finishedAt
    )
      invalid();
    if (item.type === "tool_call") sawTool = true;
    else if (
      item.type !== "message" ||
      item.role !== "assistant" ||
      item.source !== "assistant_completion" ||
      sawTool
    )
      invalid();
  }
  for (const [index, item] of toolItems.entries()) {
    const event = toolEvents[index]!;
    if (
      item.callId !== event.data.callId ||
      item.kind !== event.data.kind ||
      item.name !== event.data.name ||
      item.input !== event.data.input
    )
      invalid();
  }
  if (
    input.modelState.tenantId !== input.commit.tenantId ||
    input.modelState.throughHistorySequence !==
      input.history.items.at(-1)?.sequence ||
    input.modelState.updatedAt !== input.attempt.finishedAt
  )
    invalid();
  const checkpointEvents = events.filter(
    (event) => event.type === "segment.checkpointed",
  );
  const continuation = input.continuation;
  if (continuation === null) {
    if (
      checkpointEvents.length !== 0 ||
      input.attempt.checkpointDigest !== null
    )
      invalid();
  } else {
    const checkpoint = parseProviderCheckpoint(continuation.checkpoint);
    const digest = `sha256:${createHash("sha256").update(stableJson(checkpoint)).digest("hex")}`;
    if (
      checkpointEvents.length !== 1 ||
      events.at(-2) !== checkpointEvents[0] ||
      checkpointEvents[0]?.data.checkpointDigest !== digest ||
      input.attempt.checkpointDigest !== digest
    )
      invalid();
    for (const key of [
      "tenantId",
      "threadId",
      "agentVersionId",
      "adapterName",
      "adapterVersion",
      "modelId",
      "throughHistorySequence",
      "contextRevision",
      "updatedAt",
    ] as const)
      if (continuation[key] !== input.modelState[key]) invalid();
    if (
      checkpoint.adapterName !== continuation.adapterName ||
      checkpoint.adapterVersion !== continuation.adapterVersion ||
      checkpoint.modelId !== continuation.modelId
    )
      invalid();
  }
  return runId;
}

function invalid(): never {
  throw new RunStoreError("tool_sample_commit_mismatch");
}

export function validateToolSampleAuthority(
  input: CommitToolSampleInput,
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

export function validateToolSampleReplay(
  input: CommitToolSampleInput,
  run: import("@crewon/application").CommitRunResult,
  step: RunStepState,
  attempt: RunAttemptState,
): void {
  validateToolSampleAuthority(input, run.state, step);
  if (
    stableJson(run.events) !== stableJson(input.commit.events) ||
    attempt.workItemId !== input.lease.workItemId ||
    attempt.leaseEpoch !== input.lease.leaseEpoch ||
    attempt.terminalAt !== input.attempt.finishedAt ||
    attempt.checkpointDigest !== input.attempt.checkpointDigest ||
    (input.continuation !== null &&
      stableJson(attempt.providerCheckpoint) !==
        stableJson(input.continuation.checkpoint))
  )
    invalid();
}
