import { useMemo } from "react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import type { ConnectionState } from "./appRuntimeState";
import {
  isPlaceholderBackendCwd,
  preferredBackendCwd,
} from "../backend/backendWorkspace";
import { threadTitle } from "../thread/threadModel";

export type AppThreadSelectionParams = {
  activeTurnByThread: Record<string, string>;
  connectionState: ConnectionState;
  draftWorkspaceCwd?: string | null;
  newDraftThreadLabel: string;
  selectedThreadId: string | null;
  threads: Thread[];
  untitledThreadLabel: string;
};

export function selectedThreadWorkspaceCwd({
  draftWorkspaceCwd,
  selectedThread,
  threads,
}: {
  draftWorkspaceCwd?: string | null;
  selectedThread: Thread | null;
  threads: Thread[];
}): string {
  const selectedThreadCwd = selectedThread?.cwd?.trim() ?? "";
  if (selectedThread) {
    return selectedThreadCwd && !isPlaceholderBackendCwd(selectedThreadCwd)
      ? selectedThreadCwd
      : "";
  }

  if (draftWorkspaceCwd === null) {
    return "";
  }

  return preferredBackendCwd(draftWorkspaceCwd, threads);
}

export function useAppThreadSelection({
  activeTurnByThread,
  connectionState,
  draftWorkspaceCwd,
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

    const cwd = selectedThreadWorkspaceCwd({
      draftWorkspaceCwd,
      selectedThread,
      threads,
    });

    return {
      activeTurnId,
      cwd,
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
    draftWorkspaceCwd,
    newDraftThreadLabel,
    selectedThreadId,
    threads,
    untitledThreadLabel,
  ]);
}
