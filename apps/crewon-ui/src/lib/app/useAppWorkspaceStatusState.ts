import { useState } from "react";
import type { ConversationSummary } from "@crewon-protocol/ConversationSummary";
import type { ThreadGoal } from "@crewon-protocol/v2/ThreadGoal";

import type {
  AccountStatus,
  GitRemoteDiffSummary,
} from "../shared/statusTypes";
import type { ToolId } from "../i18n";

export function useAppWorkspaceStatusState() {
  const [accountStatus, setAccountStatus] = useState<AccountStatus | null>(
    null,
  );
  const [conversationSummary, setConversationSummary] =
    useState<ConversationSummary | null>(null);
  const [gitRemoteDiff, setGitRemoteDiff] =
    useState<GitRemoteDiffSummary | null>(null);
  const [threadGoal, setThreadGoal] = useState<ThreadGoal | null>(null);
  const [activeFileWatch, setActiveFileWatch] = useState<{
    id: string;
    path: string;
  } | null>(null);
  const [busyToolId, setBusyToolId] = useState<ToolId | null>(null);

  return {
    accountStatus,
    activeFileWatch,
    busyToolId,
    conversationSummary,
    gitRemoteDiff,
    setAccountStatus,
    setActiveFileWatch,
    setBusyToolId,
    setConversationSummary,
    setGitRemoteDiff,
    setThreadGoal,
    threadGoal,
  };
}
