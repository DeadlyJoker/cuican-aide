/** Presentation ownership only moves forward; an older stream cannot regain it. */
export function retireOtherRunPresentations(
  streams: ReadonlyMap<string, { threadId: string; presentsThread: boolean }>,
  threadId: string,
  successorRunId: string,
): boolean {
  let changed = false;
  for (const [runId, stream] of streams) {
    if (
      stream.threadId !== threadId ||
      runId === successorRunId ||
      !stream.presentsThread
    )
      continue;
    stream.presentsThread = false;
    changed = true;
  }
  return changed;
}
