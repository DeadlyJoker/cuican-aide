/** Preserve ordered cleanup and aggregate every failure, including optional recovery ownership. */
export async function closeResources(
  tasks: readonly (() => void | Promise<void> | undefined)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const task of tasks)
    try {
      await task();
    } catch (failure) {
      failures.push(failure);
    }
  if (failures.length)
    throw new AggregateError(failures, "production_control_api_cleanup_failed");
}
