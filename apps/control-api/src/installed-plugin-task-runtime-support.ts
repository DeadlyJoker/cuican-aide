export function method<T extends object, K extends keyof T>(
  input: T,
  key: K,
): T[K] {
  const value = input?.[key];
  if (typeof value !== "function") invalid();
  return value.bind(input) as T[K];
}

export async function closeAll(
  actions: readonly (() => Promise<unknown> | undefined)[],
): Promise<void> {
  const results = await Promise.allSettled(
    actions.map((action) => {
      try {
        return Promise.resolve(action());
      } catch (error) {
        return Promise.reject(error);
      }
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(failures, "installed_plugin_task_cleanup_failed");
}

function invalid(): never {
  throw new Error("installed_plugin_task_runtime_core_invalid");
}
