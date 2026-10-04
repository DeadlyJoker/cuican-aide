import type { PublicConceptGeneration } from "@crewon/plugin-sdk/contracts";

export const GENERATION_OBSERVATION_LIMITS = Object.freeze({
  intervalMs: 2_000,
  maximumReads: 60,
  windowMs: 120_000,
  readTimeoutMs: 10_000,
});

/** An original Run can finish before its external operation does. */
export function generationNeedsObservation(
  generation: PublicConceptGeneration,
): boolean {
  const task = generation.task;
  return (
    !["completed", "failed", "canceled"].includes(task.runStatus) ||
    task.truncated ||
    task.operations.some(
      (operation) =>
        operation.status !== "succeeded" && operation.status !== "failed",
    )
  );
}
