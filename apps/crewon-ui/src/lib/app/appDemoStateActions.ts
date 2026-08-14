import type { ConversationSummary } from "@crewon-ui-model/ConversationSummary";
import type { Thread } from "@crewon-ui-model/v2/Thread";
import type { ThreadGoalView } from "@crewon/contracts";

import {
  demoAccountStatus,
  demoConversationSummary,
  demoGitRemoteDiff,
  demoThreadGoal,
} from "../demo/demoContent";
import { getDemoThreads } from "../demo/demoData";
import type { AccountStatus, GitRemoteDiffSummary } from "./appStatusTypes";
import type { ConnectionState } from "./appRuntimeState";
import type { Locale } from "../i18n";

type ThreadListSetter = (
  updater: (currentThreads: Thread[]) => Thread[],
) => void;

function localizeSeedDemoThreads(
  currentThreads: Thread[],
  locale: Locale,
): Thread[] {
  const seedThreadById = new Map(
    getDemoThreads(locale).map((thread) => [thread.id, thread]),
  );
  return currentThreads.map(
    (thread) => seedThreadById.get(thread.id) ?? thread,
  );
}

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
