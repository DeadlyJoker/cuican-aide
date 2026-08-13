import { useState } from "react";
import type { ConversationSummary } from "@crewon-ui-model/ConversationSummary";
import type { ThreadGoalView } from "@crewon/contracts";

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
  const [threadGoal, setThreadGoal] = useState<ThreadGoalView | null>(null);
  const [threadGoalBusy, setThreadGoalBusy] = useState(false);
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
    setThreadGoalBusy,
    threadGoal,
    threadGoalBusy,
  };
}
