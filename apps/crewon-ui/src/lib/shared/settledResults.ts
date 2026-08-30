export function settledErrorMessages(
  results: readonly PromiseSettledResult<unknown>[],
): string[] {
  return results.flatMap((result) =>
    result.status === "rejected" && result.reason instanceof Error
      ? [result.reason.message]
      : [],
  );
}

export function settledValue<T, F>(
  result: PromiseSettledResult<T>,
  fallback: F,
): NonNullable<T> | F {
  return result.status === "fulfilled" ? (result.value ?? fallback) : fallback;
}

export function settledMappedValue<T, R, F>(
  result: PromiseSettledResult<T>,
  mapper: (value: T) => R | null | undefined,
  fallback: F,
): NonNullable<R> | F {
  return result.status === "fulfilled"
    ? (mapper(result.value) ?? fallback)
    : fallback;
}
