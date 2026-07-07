import type { ConversationSummary } from "@crewon-protocol/ConversationSummary";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadGoal } from "@crewon-protocol/v2/ThreadGoal";

import type { AppView } from "./appRouting";
import type { AccountStatus } from "./appStatusTypes";
import type { LibraryKind, LibraryPanel } from "../domain/crewonDomain";
import type { SettingsSection } from "../settings/settingsCatalog";
import { upsertThread } from "../thread/threadModel";

type ThreadListSetter = (updater: (current: Thread[]) => Thread[]) => void;
type ThreadListReplaceSetter = (threads: Thread[]) => void;

type NotificationRefreshClient = {
  getAccount(): Promise<AccountStatus>;
  getConversationSummary(
    threadId: string,
  ): Promise<{ summary: ConversationSummary | null }>;
  getThreadGoal(threadId: string): Promise<{ goal: ThreadGoal | null }>;
  listThreads(archived: boolean): Promise<Thread[]>;
  readThread(threadId: string): Promise<Thread>;
};

export function refreshAccountFromClientAction(params: {
  client: Pick<NotificationRefreshClient, "getAccount"> | null | undefined;
  setAccountStatus: (accountStatus: AccountStatus) => void;
}): void {
  void params.client
    ?.getAccount()
    .then(params.setAccountStatus)
    .catch(() => undefined);
}

export function refreshThreadFromClientAction(params: {
  client: Pick<NotificationRefreshClient, "readThread"> | null | undefined;
  setThreads: ThreadListSetter;
  threadId: string;
}): void {
  void params.client
    ?.readThread(params.threadId)
    .then((thread) => {
      params.setThreads((current) => upsertThread(current, thread));
    })
    .catch(() => undefined);
}

export function reloadThreadsFromClientAction(params: {
  archived: boolean;
  client: Pick<NotificationRefreshClient, "listThreads"> | null | undefined;
  setThreads: ThreadListReplaceSetter;
}): void {
  void params.client
    ?.listThreads(params.archived)
    .then(params.setThreads)
    .catch(() => undefined);
}

export function refreshSelectedThreadGoalFromClientAction(params: {
  client: Pick<NotificationRefreshClient, "getThreadGoal"> | null | undefined;
  setThreadGoal: (goal: ThreadGoal | null) => void;
  threadId: string;
}): void {
  void params.client
    ?.getThreadGoal(params.threadId)
    .then((response) => params.setThreadGoal(response.goal))
    .catch(() => undefined);
}

export function runSelectedThreadSummaryEffectAction(params: {
  client:
    | Pick<NotificationRefreshClient, "getConversationSummary">
    | null
    | undefined;
  isConnected: boolean;
  isDemo: boolean;
  isDemoThreadSelected: boolean;
  selectedThreadId: string | null;
  setConversationSummary: (summary: ConversationSummary | null) => void;
}): (() => void) | undefined {
  if (
    !params.isConnected ||
    !params.selectedThreadId ||
    params.isDemoThreadSelected
  ) {
    if (!params.isDemo) {
      params.setConversationSummary(null);
    }
    return undefined;
  }

  let cancelled = false;
  void params.client
    ?.getConversationSummary(params.selectedThreadId)
    .then((response) => {
      if (!cancelled) {
        params.setConversationSummary(response.summary);
      }
    })
    .catch(() => {
      if (!cancelled) {
        params.setConversationSummary(null);
      }
    });

  return () => {
    cancelled = true;
  };
}

export function runSelectedThreadGoalEffectAction(params: {
  client: Pick<NotificationRefreshClient, "getThreadGoal"> | null | undefined;
  isConnected: boolean;
  isDemo: boolean;
  isDemoThreadSelected: boolean;
  selectedThreadId: string | null;
  setThreadGoal: (goal: ThreadGoal | null) => void;
}): (() => void) | undefined {
  if (
    !params.isConnected ||
    !params.selectedThreadId ||
    params.isDemoThreadSelected
  ) {
    if (!params.isDemo) {
      params.setThreadGoal(null);
    }
    return undefined;
  }

  let cancelled = false;
  void params.client
    ?.getThreadGoal(params.selectedThreadId)
    .then((response) => {
      if (!cancelled) {
        params.setThreadGoal(response.goal);
      }
    })
    .catch(() => {
      if (!cancelled) {
        params.setThreadGoal(null);
      }
    });

  return () => {
    cancelled = true;
  };
}

export function refreshVisibleLibraryAction(params: {
  appView: AppView;
  kind: LibraryKind;
  libraryPanel: LibraryPanel | null;
  openLibrary: (kind: LibraryKind) => void | Promise<void>;
}): void {
  if (params.appView === "library" && params.libraryPanel?.kind === params.kind) {
    void params.openLibrary(params.kind);
  }
}

export function refreshVisibleSettingsAction(params: {
  appView: AppView;
  refreshSettingsSection: (section: SettingsSection) => void | Promise<void>;
  sections: SettingsSection[];
  settingsSection: SettingsSection;
}): void {
  if (
    params.appView === "settings" &&
    params.sections.includes(params.settingsSection)
  ) {
    void params.refreshSettingsSection(params.settingsSection);
  }
}
