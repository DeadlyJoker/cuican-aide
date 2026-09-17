type RunPresentation = { threadId: string; presentsThread: boolean };

/** Existing streams relinquish presentation without retaining another Run registry. */
export function retireOtherRunPresentations(
  streams: ReadonlyMap<string, RunPresentation>,
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

export function assertRunPresentationReadCurrent(input: {
  streams: ReadonlyMap<string, RunPresentation>;
  priorStreams: ReadonlyMap<string, RunPresentation>;
  threadId: string;
  activeRunId: string | null;
}): void {
  for (const [runId, stream] of input.streams) {
    // The read may start its own authoritative stream during optional hydration.
    if (
      stream.threadId === input.threadId &&
      runId !== input.activeRunId &&
      input.priorStreams.get(runId) !== stream
    ) {
      throw new Error("control_thread_projection_superseded");
    }
  }
}
