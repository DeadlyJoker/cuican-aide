import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";

import type {
  AppServerNotification,
  OfficeDelegationDispatchResponse,
} from "../app-server/appServer";
import {
  automationRunSyncFailureNotice,
  officeRunSyncFailureNotice,
} from "./appNotificationPresentation";
import { clearThreadText, removeRecordKey } from "./appNotificationState";
import type { NoticeState } from "./appRuntimeState";
import {
  officeConfigForThread,
  type LibraryItem,
  type LibraryPanel,
  type OfficeConfig,
} from "../domain/crewonDomain";
import { matchingAutomationRunSyncedPanel } from "../automation/automationDetailPanel";
import { automationRunLifecycleText } from "../domain/domainAutomationContent";
import type { Locale } from "../i18n";
import {
  officeDelegationDispatchFailureNotice,
  officeRunActiveTurnByThread,
  officeRunSyncedPanel,
  officeRunTurnRecord,
} from "../office/officeRunPanel";
import { updateThreadTurns, upsertTurnInThread } from "../thread/threadModel";

type StateSetter<T> = (updater: (current: T) => T) => void;

export type AutomationRunTurnRecord = {
  filePath: string;
  runId: string;
  threadId: string;
};

export type OfficeRunTurnRecord = {
  config: OfficeConfig;
  cwd: string;
  runId: string;
  threadId: string;
  turnThreadId?: string;
};

export type TurnCompletionNotificationHandlerParams = {
  automationRunsByTurn: Record<string, AutomationRunTurnRecord>;
  getLibraryPanel: () => LibraryPanel | null;
  listThreadTurns: (threadId: string) => Promise<Turn[] | null | undefined>;
  locale: Locale;
  notification: AppServerNotification;
  officeRunsByTurn: Record<string, OfficeRunTurnRecord>;
  readAutomationRunItems: (threadId: string) => Promise<LibraryItem[]>;
  setActiveTurnByThread: StateSetter<Record<string, string>>;
  setLibraryPanel: StateSetter<LibraryPanel | null>;
  setNotice: (notice: NoticeState | null) => void;
  setStreamingTextByThread: StateSetter<Record<string, string>>;
  setThreads: StateSetter<Thread[]>;
  syncAutomationRun: (
    filePath: string,
    status: string,
    completedAt: number | null,
  ) => Promise<void>;
  autoDispatchNextOfficeDelegation?: (
    record: OfficeRunTurnRecord,
    config: OfficeConfig,
  ) => Promise<OfficeDelegationDispatchResponse | null | undefined>;
  syncOfficeRun: (
    record: OfficeRunTurnRecord,
    config: OfficeConfig,
    turn: Turn,
  ) => Promise<OfficeConfig | null | undefined>;
  unixNow: () => number;
};

export function handleTurnCompletionAppNotification({
  automationRunsByTurn,
  getLibraryPanel,
  listThreadTurns,
  locale,
  notification,
  officeRunsByTurn,
  readAutomationRunItems,
  setActiveTurnByThread,
  setLibraryPanel,
  setNotice,
  setStreamingTextByThread,
  setThreads,
  syncAutomationRun,
  autoDispatchNextOfficeDelegation,
  syncOfficeRun,
  unixNow,
}: TurnCompletionNotificationHandlerParams): boolean {
  if (notification.method !== "turn/completed") {
    return false;
  }

  const { threadId, turn } = notification.params;
  setThreads((current) => upsertTurnInThread(current, threadId, turn));
  setStreamingTextByThread((current) => clearThreadText(current, threadId));
  setActiveTurnByThread((current) => removeRecordKey(current, threadId));
  void refreshCompletedThreadTurns({
    listThreadTurns,
    setThreads,
    threadId,
  });

  const automationRunRecord = automationRunsByTurn[turn.id];
  if (automationRunRecord) {
    void syncAutomationTurnCompletion({
      automationRunRecord,
      automationRunsByTurn,
      locale,
      readAutomationRunItems,
      setLibraryPanel,
      setNotice,
      syncAutomationRun,
      threadId,
      turn,
      unixNow,
    });
  }

  const officeRunRecord = officeRunsByTurn[turn.id];
  if (officeRunRecord) {
    void syncOfficeTurnCompletion({
      getLibraryPanel,
      listThreadTurns,
      locale,
      officeRunRecord,
      officeRunsByTurn,
      setLibraryPanel,
      setNotice,
      setActiveTurnByThread,
      syncOfficeRun,
      autoDispatchNextOfficeDelegation,
      threadId,
      turn,
      setThreads,
    });
  }

  return true;
}

async function refreshCompletedThreadTurns({
  listThreadTurns,
  setThreads,
  threadId,
}: {
  listThreadTurns: (threadId: string) => Promise<Turn[] | null | undefined>;
  setThreads: StateSetter<Thread[]>;
  threadId: string;
}): Promise<void> {
  const turns = await listThreadTurns(threadId).catch(() => null);
  if (!turns) {
    return;
  }
  setThreads((current) => updateThreadTurns(current, threadId, turns));
}

async function syncAutomationTurnCompletion({
  automationRunRecord,
  automationRunsByTurn,
  locale,
  readAutomationRunItems,
  setLibraryPanel,
  setNotice,
  syncAutomationRun,
  threadId,
  turn,
  unixNow,
}: {
  automationRunRecord: AutomationRunTurnRecord;
  automationRunsByTurn: Record<string, AutomationRunTurnRecord>;
  locale: Locale;
  readAutomationRunItems: (threadId: string) => Promise<LibraryItem[]>;
  setLibraryPanel: StateSetter<LibraryPanel | null>;
  setNotice: (notice: NoticeState | null) => void;
  syncAutomationRun: (
    filePath: string,
    status: string,
    completedAt: number | null,
  ) => Promise<void>;
  threadId: string;
  turn: Turn;
  unixNow: () => number;
}): Promise<void> {
  try {
    await syncAutomationRun(
      automationRunRecord.filePath,
      turn.status,
      turn.completedAt ?? unixNow(),
    );
    delete automationRunsByTurn[turn.id];
    const items = await readAutomationRunItems(threadId);
    setLibraryPanel((currentPanel) =>
      matchingAutomationRunSyncedPanel(currentPanel, {
        items,
        lifecycleLines: automationRunLifecycleText({
          configPath: null,
          locale,
          phase: "completed",
          runFilePath: automationRunRecord.filePath,
          runId: automationRunRecord.runId,
          threadId,
        }),
        threadId,
      }),
    );
  } catch (error) {
    setNotice(automationRunSyncFailureNotice(error, locale));
  }
}

async function syncOfficeTurnCompletion({
  autoDispatchNextOfficeDelegation,
  getLibraryPanel,
  listThreadTurns,
  locale,
  officeRunRecord,
  officeRunsByTurn,
  setActiveTurnByThread,
  setLibraryPanel,
  setNotice,
  setThreads,
  syncOfficeRun,
  threadId,
  turn,
}: {
  autoDispatchNextOfficeDelegation?: (
    record: OfficeRunTurnRecord,
    config: OfficeConfig,
  ) => Promise<OfficeDelegationDispatchResponse | null | undefined>;
  getLibraryPanel: () => LibraryPanel | null;
  listThreadTurns: (threadId: string) => Promise<Turn[] | null | undefined>;
  locale: Locale;
  officeRunRecord: OfficeRunTurnRecord;
  officeRunsByTurn: Record<string, OfficeRunTurnRecord>;
  setActiveTurnByThread: StateSetter<Record<string, string>>;
  setLibraryPanel: StateSetter<LibraryPanel | null>;
  setNotice: (notice: NoticeState | null) => void;
  setThreads: StateSetter<Thread[]>;
  syncOfficeRun: (
    record: OfficeRunTurnRecord,
    config: OfficeConfig,
    turn: Turn,
  ) => Promise<OfficeConfig | null | undefined>;
  threadId: string;
  turn: Turn;
}): Promise<void> {
  try {
    const fullTurn =
      (await listThreadTurns(threadId)
        .then((turns) => turns?.find((candidate) => candidate.id === turn.id))
        .catch(() => null)) ?? turn;
    const currentPanel = getLibraryPanel();
    const config =
      currentPanel?.kind === "office" &&
      currentPanel.workspace?.threadId === officeRunRecord.threadId
        ? officeConfigForThread(
            currentPanel.title,
            currentPanel.subtitle,
            currentPanel.workspace,
            officeRunRecord.threadId,
          )
        : officeRunRecord.config;
    const syncedConfig = await syncOfficeRun(officeRunRecord, config, fullTurn);
    delete officeRunsByTurn[turn.id];
    if (!syncedConfig) {
      return;
    }
    setLibraryPanel((currentPanel) =>
      officeRunSyncedPanel(currentPanel, {
        config: syncedConfig,
        threadId: officeRunRecord.threadId,
      }),
    );
    if (!autoDispatchNextOfficeDelegation) {
      return;
    }
    const dispatchResponse = await autoDispatchNextOfficeDelegation(
      officeRunRecord,
      syncedConfig,
    ).catch((error) => {
      setNotice(officeDelegationDispatchFailureNotice(error, locale));
      return null;
    });
    if (!dispatchResponse) {
      return;
    }
    officeRunsByTurn[dispatchResponse.turn.id] = officeRunTurnRecord(
      officeRunRecord.cwd,
      dispatchResponse,
    );
    setThreads((current) =>
      upsertTurnInThread(
        current,
        dispatchResponse.threadId,
        dispatchResponse.turn,
      ),
    );
    setActiveTurnByThread((current) =>
      officeRunActiveTurnByThread(current, dispatchResponse),
    );
    setLibraryPanel((currentPanel) =>
      officeRunSyncedPanel(currentPanel, {
        config: dispatchResponse.config,
        threadId: officeRunRecord.threadId,
      }),
    );
  } catch (error) {
    setNotice(officeRunSyncFailureNotice(error, locale));
  }
}
