/** Keep lease ownership until every started Tool call has settled, including errors. */
export async function resolveToolBatch<T>(input: {
  calls: readonly (() => Promise<T>)[];
  mode: "parallel" | "sequential";
  shouldContinue?: (value: T) => boolean;
}): Promise<PromiseSettledResult<T>[]> {
  if (input.mode === "sequential") {
    const values: PromiseSettledResult<T>[] = [];
    for (const call of input.calls) {
      try {
        const value = await call();
        values.push({ status: "fulfilled", value });
        if (input.shouldContinue?.(value) === false) break;
      } catch (reason) {
        values.push({ status: "rejected", reason });
        break;
      }
    }
    return values;
  }
  return Promise.allSettled(input.calls.map(async (call) => call()));
}
