type ToolBatchInput<T> = {
  calls: readonly (() => Promise<T>)[];
  mode: "parallel" | "sequential";
  shouldContinue?: (value: T) => boolean;
};

/** Publish the settled input-order prefix without waiting for later siblings.
 * Always join started calls before lease/resource ownership can be released.
 */
export async function* streamToolBatch<T>(
  input: ToolBatchInput<T>,
): AsyncGenerator<PromiseSettledResult<T>, void> {
  if (input.mode === "sequential") {
    for (const call of input.calls) {
      let result: PromiseSettledResult<T>;
      try {
        result = { status: "fulfilled", value: await call() };
      } catch (reason) {
        result = { status: "rejected", reason };
      }
      yield result;
      if (
        result.status === "rejected" ||
        input.shouldContinue?.(result.value) === false
      )
        break;
    }
    return;
  }
  const started = input.calls.map((call) =>
    Promise.resolve()
      .then(call)
      .then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      ),
  );
  try {
    for (const result of started) yield await result;
  } finally {
    await Promise.all(started);
  }
}

/** Compatibility collector for callers that need the complete ordered batch. */
export async function resolveToolBatch<T>(
  input: ToolBatchInput<T>,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  for await (const result of streamToolBatch(input)) results.push(result);
  return results;
}
