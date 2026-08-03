import type { Thread } from "@crewon-protocol/v2/Thread";

type CommandShellRuntimeStateParams = {
  activeTurnByThread: Record<string, string>;
  activeTurnId: string | null;
  renderCommandShell: boolean;
  selectedThread: Thread | null;
  selectedThreadId: string | null;
  streamingTextByThread: Record<string, string>;
  threads: Thread[];
};

/**
 * Live turn and streaming text for the assistant thread.
 *
 * The assistant pane resolves these the same way the shell does: prefer the
 * tracked active turn, otherwise fall back to whichever turn is still running.
 */
export function assistantThreadRuntimeState({
  activeTurnByThread,
  assistantThread,
  streamingTextByThread,
}: {
  activeTurnByThread: Record<string, string>;
  assistantThread: Thread | null;
  streamingTextByThread: Record<string, string>;
}): { activeTurnId: string | null; streamingText: string } {
  if (!assistantThread) {
    return { activeTurnId: null, streamingText: "" };
  }
  return {
    activeTurnId:
      activeTurnByThread[assistantThread.id] ??
      assistantThread.turns.find((turn) => turn.status === "inProgress")?.id ??
      null,
    streamingText: streamingTextByThread[assistantThread.id] ?? "",
  };
}

export function commandShellRuntimeState({
  activeTurnByThread,
  activeTurnId,
  renderCommandShell,
  selectedThread,
  selectedThreadId,
  streamingTextByThread,
  threads,
}: CommandShellRuntimeStateParams): {
  activeTurnId: string | null;
  selectedThread: Thread | null;
  selectedThreadId: string | null;
  streamingText: string;
} {
  if (!renderCommandShell) {
    return {
      activeTurnId,
      selectedThread,
      selectedThreadId,
      streamingText: selectedThreadId
        ? (streamingTextByThread[selectedThreadId] ?? "")
        : "",
    };
  }

  const streamingThreadId = selectedThreadId;
  const shellThread = streamingThreadId
    ? ((selectedThread?.id === streamingThreadId ? selectedThread : null) ??
      threads.find((thread) => thread.id === streamingThreadId) ??
      null)
    : null;

  return {
    activeTurnId: streamingThreadId
      ? (activeTurnByThread[streamingThreadId] ??
        shellThread?.turns.find((turn) => turn.status === "inProgress")?.id ??
        null)
      : activeTurnId,
    selectedThread: shellThread,
    selectedThreadId: streamingThreadId,
    streamingText: streamingThreadId
      ? (streamingTextByThread[streamingThreadId] ?? "")
      : "",
  };
}
