export function isDemoThreadId(threadId: string | null | undefined): boolean {
  return Boolean(threadId?.startsWith("demo-"));
}

export function backendThreadId(
  threadId: string | null | undefined,
): string | null {
  return threadId && !isDemoThreadId(threadId) ? threadId : null;
}

export function previewAwareBackendThreadId(
  threadId: string | null | undefined,
  isDemoPreview: boolean,
): string | null {
  return threadId && !(isDemoPreview && isDemoThreadId(threadId))
    ? threadId
    : null;
}
