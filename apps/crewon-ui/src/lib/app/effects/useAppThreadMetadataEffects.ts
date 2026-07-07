import { useEffect } from "react";
import type { ConversationSummary } from "@crewon-protocol/ConversationSummary";
import type { ThreadGoal } from "@crewon-protocol/v2/ThreadGoal";

import type { AppServerClient } from "../../app-server/appServer";
import { runGitRemoteDiffEffectAction } from "../appGitRemoteDiffActions";
import {
  runSelectedThreadGoalEffectAction,
  runSelectedThreadSummaryEffectAction,
} from "../appNotificationRefreshActions";
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
  setThreadGoal: (goal: ThreadGoal | null) => void;
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
  setThreadGoal,
}: AppThreadMetadataEffectsParams) {
  const isDemoThreadSelected =
    Boolean(selectedThreadId) && isDemoPreview && isDemoThreadId(selectedThreadId);

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

  useEffect(() => {
    return runSelectedThreadGoalEffectAction({
      client,
      isConnected,
      isDemo,
      isDemoThreadSelected,
      selectedThreadId,
      setThreadGoal,
    });
  }, [
    client,
    isConnected,
    isDemo,
    isDemoThreadSelected,
    selectedThreadId,
    setThreadGoal,
  ]);
}
