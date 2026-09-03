import type { RunPlanView } from "@crewon/contracts";

const MAX_RETAINED_RUN_PLANS = 128;

/**
 * Bounded UI-only projection of the authoritative execution checklist for one
 * Run. It deliberately stays outside the transcript model: ProposedPlan is a
 * final Plan-mode artifact, while this state changes during execution.
 */
export type ThreadRunPlanProjection = Readonly<{
  eventSequence: number;
  plan: RunPlanView | null;
  runId: string;
  threadId: string;
}>;

export type ControlRunPlanProjectionState = Readonly<
  Record<string, ThreadRunPlanProjection>
>;

export function applyControlRunPlanProjection(
  current: ControlRunPlanProjectionState,
  incoming: ThreadRunPlanProjection,
): ControlRunPlanProjectionState {
  if (
    !Number.isSafeInteger(incoming.eventSequence) ||
    incoming.eventSequence < 0 ||
    (incoming.plan !== null &&
      (incoming.eventSequence < 1 || incoming.plan.planId !== incoming.runId))
  ) {
    throw new Error("control_run_plan_projection_invalid");
  }
  const existing = current[incoming.runId];
  if (existing && existing.threadId !== incoming.threadId) {
    throw new Error("control_run_plan_thread_identity_conflict");
  }

  const nextProjection = newerRunPlanProjection(existing, incoming);
  if (nextProjection === existing) {
    return current;
  }

  const next = { ...current, [incoming.runId]: nextProjection };
  const retainedRunIds = Object.keys(next);
  if (retainedRunIds.length <= MAX_RETAINED_RUN_PLANS) {
    return next;
  }

  // Object key insertion order is stable. Run sequences restart at zero for
  // every Run, so comparing them across Runs cannot identify the oldest entry.
  const oldestRunId = retainedRunIds[0];
  if (!oldestRunId) return next;
  delete next[oldestRunId];
  return next;
}

export function removeThreadRunPlanProjections(
  current: ControlRunPlanProjectionState,
  threadId: string,
): ControlRunPlanProjectionState {
  const retained = Object.entries(current).filter(
    ([, projection]) => projection.threadId !== threadId,
  );
  return retained.length === Object.keys(current).length
    ? current
    : Object.fromEntries(retained);
}

export function selectThreadRunPlanProjection(
  current: ControlRunPlanProjectionState,
  threadId: string | null,
  runId: string | null,
): ThreadRunPlanProjection | null {
  if (threadId === null || runId === null) {
    return null;
  }
  const projection = current[runId];
  return projection?.threadId === threadId ? projection : null;
}

function newerRunPlanProjection(
  existing: ThreadRunPlanProjection | undefined,
  incoming: ThreadRunPlanProjection,
): ThreadRunPlanProjection {
  if (!existing) {
    return incoming;
  }

  if (incoming.plan === null) {
    // A reconnect/adoption marker must never erase a snapshot already observed
    // for the same Run. A genuinely plan-less Run starts with no map entry.
    return existing.plan === null &&
      incoming.eventSequence > existing.eventSequence
      ? incoming
      : existing;
  }
  if (existing.plan === null) {
    return incoming;
  }
  if (incoming.plan.revision < existing.plan.revision) {
    return existing;
  }
  if (incoming.plan.revision === existing.plan.revision) {
    if (!sameRunPlanSnapshot(existing.plan, incoming.plan)) {
      throw new Error("control_run_plan_revision_conflict");
    }
    return incoming.eventSequence > existing.eventSequence
      ? incoming
      : existing;
  }
  if (incoming.eventSequence <= existing.eventSequence) {
    throw new Error("control_run_plan_sequence_regression");
  }
  return incoming;
}

function sameRunPlanSnapshot(left: RunPlanView, right: RunPlanView): boolean {
  if (
    left.schemaVersion !== right.schemaVersion ||
    left.planId !== right.planId ||
    left.revision !== right.revision ||
    left.explanation !== right.explanation ||
    left.createdAt !== right.createdAt ||
    left.updatedAt !== right.updatedAt ||
    left.items.length !== right.items.length
  ) {
    return false;
  }
  return left.items.every((item, index) => {
    const candidate = right.items[index];
    return (
      candidate !== undefined &&
      item.itemId === candidate.itemId &&
      item.title === candidate.title &&
      item.status === candidate.status
    );
  });
}
