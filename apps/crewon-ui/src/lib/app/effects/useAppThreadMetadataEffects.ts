import { useEffect } from "react";
import type { ConversationSummary } from "@crewon-protocol/ConversationSummary";

import type { AppServerClient } from "../../app-server/appServer";
import { runGitRemoteDiffEffectAction } from "../appGitRemoteDiffActions";
import { runSelectedThreadSummaryEffectAction } from "../appNotificationRefreshActions";
import type { GitRemoteDiffSummary } from "../appStatusTypes";
import { isDemoThreadId } from "../appUiState";

export type AppThreadMetadataEffectsParams = {
  client: AppServerClient | null;
  cwd: string;
  isConnected: boolean;
  isDemo: boolean;
  isDemoPreview: boolean;
  selectedThreadId: string | null;
  setConversationSummary: (summary: ConversationSummary | null) => void;
  setGitRemoteDiff: (diff: GitRemoteDiffSummary | null) => void;
};

export function useAppThreadMetadataEffects({
  client,
  cwd,
  isConnected,
  isDemo,
  isDemoPreview,
  selectedThreadId,
  setConversationSummary,
  setGitRemoteDiff,
}: AppThreadMetadataEffectsParams) {
  const isDemoThreadSelected =
    Boolean(selectedThreadId) &&
    isDemoPreview &&
    isDemoThreadId(selectedThreadId);

  useEffect(() => {
    return runGitRemoteDiffEffectAction({
      client,
      cwd,
      isConnected,
      isDemo,
      setGitRemoteDiff,
    });
  }, [client, cwd, isConnected, isDemo, setGitRemoteDiff]);

  useEffect(() => {
    return runSelectedThreadSummaryEffectAction({
      client,
      isConnected,
      isDemo,
      isDemoThreadSelected,
      selectedThreadId,
      setConversationSummary,
    });
  }, [
    client,
    isConnected,
    isDemo,
    isDemoThreadSelected,
    selectedThreadId,
    setConversationSummary,
  ]);
}
