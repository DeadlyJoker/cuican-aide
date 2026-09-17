/** Additional empty responses tolerated before refusing another generation. */
export const MAX_EMPTY_PROVIDER_CONTINUATIONS = 3;
/** Assistant-only continuations; Tool rounds have their own execution budget. */
export const MAX_ASSISTANT_PROVIDER_CONTINUATIONS = 32;

export type EmptyProviderContinuationSource = Readonly<{
  stepId: string;
  attemptId: string;
  contextRevision: string;
}>;
export function isEmptyProviderContinuationSource(
  value: unknown,
): value is EmptyProviderContinuationSource {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") ===
      "attemptId,contextRevision,stepId" &&
    Object.values(value).every(
      (item) =>
        typeof item === "string" &&
        item.trim().length > 0 &&
        item.length <= 512 &&
        !/[\u0000-\u001f]/u.test(item),
    )
  );
}
