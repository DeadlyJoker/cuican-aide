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

  const streamingThreadId =
    selectedThreadId ??
    Object.entries(streamingTextByThread).find(
      ([, text]) => text.trim().length > 0,
    )?.[0] ??
    null;
  const shellThread = streamingThreadId
    ? (selectedThread ??
      threads.find((thread) => thread.id === streamingThreadId) ??
      null)
    : selectedThread;

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
