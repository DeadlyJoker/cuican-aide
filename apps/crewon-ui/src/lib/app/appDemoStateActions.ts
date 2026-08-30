import type { ConversationSummary } from "@crewon/app-server-protocol/ConversationSummary";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadGoalView } from "@crewon/contracts";

import {
  demoAccountStatus,
  demoConversationSummary,
  demoGitRemoteDiff,
  demoThreadGoal,
} from "../demo/demoContent";
import { localizeSeedDemoThreads } from "./appUiState";
import type { AccountStatus, GitRemoteDiffSummary } from "./appStatusTypes";
import type { ConnectionState } from "./appRuntimeState";
import type { Locale } from "../i18n";

type ThreadListSetter = (
  updater: (currentThreads: Thread[]) => Thread[],
) => void;

export function localizeDemoThreadsAction(params: {
  connectionState: ConnectionState;
  locale: Locale;
  setThreads: ThreadListSetter;
}): boolean {
  if (params.connectionState !== "demo") {
    return false;
  }
  params.setThreads((currentThreads) =>
    localizeSeedDemoThreads(currentThreads, params.locale),
  );
  return true;
}

export function syncDemoInspectorStateAction(params: {
  isDemo: boolean;
  locale: Locale;
  selectedThread: Thread | null;
  selectedThreadId: string | null;
  setAccountStatus: (accountStatus: AccountStatus | null) => void;
  setConversationSummary: (summary: ConversationSummary | null) => void;
  setGitRemoteDiff: (diff: GitRemoteDiffSummary | null) => void;
  setThreadGoal: (goal: ThreadGoalView | null) => void;
}): boolean {
  if (!params.isDemo) {
    return false;
  }
  params.setAccountStatus(demoAccountStatus(params.locale));
  params.setGitRemoteDiff(params.selectedThread ? demoGitRemoteDiff() : null);
  params.setConversationSummary(
    params.selectedThreadId ? demoConversationSummary(params.locale) : null,
  );
  params.setThreadGoal(
    params.selectedThreadId ? demoThreadGoal(params.locale) : null,
  );
  return true;
}
