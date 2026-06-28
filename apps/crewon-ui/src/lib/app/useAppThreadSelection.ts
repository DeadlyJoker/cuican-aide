import { useMemo } from "react";
import type { Thread } from "@crewon-protocol/v2/Thread";

import type { ConnectionState } from "./appRuntimeState";
import { threadTitle } from "../thread/threadModel";

export type AppThreadSelectionParams = {
  activeTurnByThread: Record<string, string>;
  connectionState: ConnectionState;
  newDraftThreadLabel: string;
  selectedThreadId: string | null;
  threads: Thread[];
  untitledThreadLabel: string;
};

export function useAppThreadSelection({
  activeTurnByThread,
  connectionState,
  newDraftThreadLabel,
  selectedThreadId,
  threads,
  untitledThreadLabel,
}: AppThreadSelectionParams) {
  return useMemo(() => {
    const selectedThread =
      threads.find((thread) => thread.id === selectedThreadId) ?? null;
    const inProgressTurnId =
      selectedThread?.turns.find((turn) => turn.status === "inProgress")?.id ??
      null;
    const activeTurnId = selectedThreadId
      ? (activeTurnByThread[selectedThreadId] ?? inProgressTurnId)
      : null;

    return {
      activeTurnId,
      cwd: selectedThread?.cwd ?? "",
      isConnected: connectionState === "connected",
      isDemo: connectionState === "demo",
      selectedThread,
      titlebarTitle: selectedThread
        ? threadTitle(selectedThread, untitledThreadLabel)
        : newDraftThreadLabel,
    };
  }, [
    activeTurnByThread,
    connectionState,
    newDraftThreadLabel,
    selectedThreadId,
    threads,
    untitledThreadLabel,
  ]);
}
