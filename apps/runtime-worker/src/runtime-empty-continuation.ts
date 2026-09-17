import {
  parseExecutionProviderCheckpoint,
  type DomainStore,
  type ThreadContinuationCheckpoint,
} from "@crewon/application";
import {
  isEmptyProviderContinuationSource,
  type RunLifecycleEvent,
  type RunState,
} from "@crewon/domain";
import type { AgentContinuation } from "@crewon/agent-kernel";
import type { ModelContextProjection } from "@crewon/context";

/** The committed Run boundary covers the input even when no output history was added. */
export function selectEmptyContinuation(
  projection: ModelContextProjection,
  stored: ThreadContinuationCheckpoint | null,
): AgentContinuation {
  if (
    stored === null ||
    stored.contextRevision !== projection.revision ||
    projection.repairs.length > 0 ||
    !Number.isSafeInteger(stored.throughHistorySequence) ||
    stored.throughHistorySequence < 1 ||
    stored.throughHistorySequence > projection.throughHistorySequence
  )
    return { kind: "manual" };
  const firstNew = projection.sourceSequences.findIndex(
    (sequence) => sequence > stored.throughHistorySequence,
  );
  const newHistoryStartIndex =
    firstNew === -1 ? projection.items.length : firstNew;
  if (
    projection.items
      .slice(newHistoryStartIndex)
      .some((item) => item.type === "message" && item.role === "assistant")
  )
    return { kind: "manual" };
  return {
    kind: "providerCheckpoint",
    checkpoint: stored.checkpoint,
    newHistoryStartIndex,
  };
}

/** Loads an immutable Run-local response; empty responses have no assistant history anchor. */
export async function loadEmptyContinuation(input: {
  store: Pick<DomainStore, "loadRunAttempt" | "loadRunStep">;
  run: Pick<RunState, "tenantId" | "runId" | "threadId" | "agentVersionId">;
  event: Extract<RunLifecycleEvent, { type: "segment.provider_continuation" }>;
  identity: Pick<
    ThreadContinuationCheckpoint,
    "agentVersionId" | "adapterName" | "adapterVersion" | "modelId"
  >;
  onInvalid: (code: string) => never;
}): Promise<ThreadContinuationCheckpoint | null> {
  const source = input.event.data.emptyContinuation;
  if (
    !isEmptyProviderContinuationSource(source) ||
    input.event.identity.runId !== input.run.runId
  )
    return input.onInvalid("empty_continuation_source_invalid");
  const scope = {
    tenantId: input.run.tenantId,
    runId: input.run.runId,
    stepId: source.stepId,
  };
  const attempt = await input.store.loadRunAttempt({
    ...scope,
    attemptId: source.attemptId,
  });
  const step = await input.store.loadRunStep(scope);
  if (
    attempt?.status !== "completed" ||
    step?.status !== "completed" ||
    step.kind !== "model" ||
    step.currentAttemptId !== attempt.attemptId ||
    attempt.terminalAt !== input.event.occurredAt ||
    step.tenantId !== scope.tenantId ||
    step.runId !== scope.runId ||
    step.stepId !== scope.stepId ||
    attempt.attemptId !== source.attemptId ||
    attempt.tenantId !== scope.tenantId ||
    attempt.runId !== scope.runId ||
    attempt.stepId !== scope.stepId
  )
    return input.onInvalid("empty_continuation_attempt_invalid");
  if (attempt.providerCheckpoint === null) return null;
  const checkpoint = parseExecutionProviderCheckpoint(
    attempt.providerCheckpoint,
  );
  if (
    checkpoint.adapterName !== input.identity.adapterName ||
    checkpoint.adapterVersion !== input.identity.adapterVersion ||
    checkpoint.modelId !== input.identity.modelId ||
    input.run.agentVersionId !== input.identity.agentVersionId
  )
    return input.onInvalid("empty_continuation_model_mismatch");
  return {
    tenantId: scope.tenantId,
    threadId: input.run.threadId,
    ...input.identity,
    checkpoint,
    throughHistorySequence: input.event.data.throughHistorySequence,
    contextRevision: source.contextRevision,
    updatedAt: input.event.occurredAt,
  };
}
