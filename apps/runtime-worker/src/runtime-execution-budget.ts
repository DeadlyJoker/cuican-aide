import { setImmediate } from "node:timers/promises";
import type { DurableQueueStore, WorkItemClaim } from "@crewon/application";
import type { RuntimeWorkerOutcome } from "./runtime-worker-outcome.ts";

/** A step may continue only after committing its recoverable boundary and closing its watchers. */
export const CONTINUE_RUN = Symbol("continue_run");
export type RuntimeWorkerStepOutcome =
  | RuntimeWorkerOutcome
  | typeof CONTINUE_RUN;
export type RuntimeExecutionBudget = Readonly<{
  maxBoundariesPerWake: number;
  maxDurationMs: number;
}>;

export function executionBudget(
  config: Partial<RuntimeExecutionBudget> = {},
): RuntimeExecutionBudget {
  const maxBoundariesPerWake = config.maxBoundariesPerWake ?? 8;
  const maxDurationMs = config.maxDurationMs ?? 5000;
  if (
    !Number.isSafeInteger(maxBoundariesPerWake) ||
    maxBoundariesPerWake < 1 ||
    maxBoundariesPerWake > 128
  )
    throw new Error("worker_execution_boundary_budget_invalid");
  if (
    !Number.isSafeInteger(maxDurationMs) ||
    maxDurationMs < 1 ||
    maxDurationMs > 60000
  )
    throw new Error("worker_execution_duration_budget_invalid");
  return Object.freeze({ maxBoundariesPerWake, maxDurationMs });
}

/** Cooperative limits never interrupt an uncommitted model/tool result or spend an execution retry. */
export async function runWithExecutionBudget(input: {
  claim: WorkItemClaim;
  store: Pick<DurableQueueStore, "retryWorkItem">;
  budget: RuntimeExecutionBudget;
  execute(): Promise<RuntimeWorkerStepOutcome>;
  shouldYield(): boolean;
}): Promise<RuntimeWorkerOutcome> {
  const started = performance.now();
  let boundaries = 0;
  for (;;) {
    const outcome = await input.execute();
    if (outcome !== CONTINUE_RUN) return outcome;
    boundaries++;
    await setImmediate();
    if (
      !input.shouldYield() &&
      boundaries < input.budget.maxBoundariesPerWake &&
      performance.now() - started < input.budget.maxDurationMs
    )
      continue;
    const { claim } = input;
    await input.store.retryWorkItem({
      workItemId: claim.workItem.workItemId,
      ownerId: claim.lease.ownerId,
      leaseId: claim.lease.leaseId,
      leaseEpoch: claim.lease.epoch,
      retryAfterMs: 1,
      reasonCode: "run_execution_yield",
    });
    return {
      kind: "retried",
      runId: claim.workItem.runId,
      code: "run_execution_yield",
    };
  }
}
