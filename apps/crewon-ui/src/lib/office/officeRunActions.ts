import type { Thread } from "@crewon-protocol/v2/Thread";

import type { OfficeRunResponse } from "../app-server/appServer";
import type { NoticeState } from "../shared/noticeState";
import type {
  LibraryPanel,
  OfficeConfig,
  OfficeRunActivity,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  officeRunActiveTurnByThread,
  officeRunCanceledPanel,
  officeRunCancelFailureNotice,
  officeRunCancelingPanel,
  officeRunCancelRollbackPanel,
  officeRunCancelUnavailableNoticeState,
  officeRunCancelUnsupportedNoticeState,
  officeRunResponsePanel,
  officeRunRetryFailureNotice,
  officeRunRetryText,
  officeRunTurnRecord,
  type OfficeRunTurnRecord,
} from "./officeRunPanel";
import { upsertTurnInThread } from "../thread/threadModel";

type StateSetter<T> = (updater: (current: T) => T) => void;
type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type OfficeRunActionPanelProvider = () => LibraryPanel | null;

export type OfficeRunCancelParams = {
  cancelOfficeRun: (
    panel: LibraryPanel,
    workspace: NonNullable<LibraryPanel["workspace"]>,
    run: OfficeRunActivity,
  ) => Promise<OfficeConfig | null>;
  isConnected: boolean;
  locale: Locale;
  panel: OfficeRunActionPanelProvider;
  run: OfficeRunActivity;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
};

export async function handleOfficeRunCancelAction({
  cancelOfficeRun,
  isConnected,
  locale,
  panel,
  run,
  setLibraryPanel,
  setNotice,
}: OfficeRunCancelParams): Promise<boolean> {
  const currentPanel = panel();
  if (!currentPanel?.workspace) {
    return false;
  }
  const threadId = run.threadId ?? currentPanel.workspace.threadId;
  if (!threadId || !run.turnId || !isConnected) {
    setNotice(officeRunCancelUnavailableNoticeState(locale));
    return true;
  }

  const previousStatus = run.status;
  setLibraryPanel((panelBeforeCancel) =>
    officeRunCancelingPanel(panelBeforeCancel, {
      runId: run.id,
      cancelRequestedAt: locale === "zh" ? "现在" : "now",
    }),
  );

  try {
    const config = await cancelOfficeRun(currentPanel, currentPanel.workspace, run);
    if (!config) {
      setNotice(officeRunCancelUnsupportedNoticeState(locale));
      return true;
    }
    setLibraryPanel((panelBeforeUpdate) =>
      officeRunCanceledPanel(panelBeforeUpdate, { config, threadId }),
    );
  } catch (error) {
    setLibraryPanel((panelBeforeRollback) =>
      officeRunCancelRollbackPanel(panelBeforeRollback, {
        runId: run.id,
        previousStatus,
      }),
    );
    setNotice(officeRunCancelFailureNotice(error, locale));
  }
  return true;
}

export type OfficeRunRetryParams = {
  isConnected: boolean;
  locale: Locale;
  panel: OfficeRunActionPanelProvider;
  recordOfficeRunTurn: (turnId: string, record: OfficeRunTurnRecord) => void;
  retryOfficeRun: (
    panel: LibraryPanel,
    workspace: NonNullable<LibraryPanel["workspace"]>,
    run: OfficeRunActivity,
    clientUserMessageId: string,
  ) => Promise<{ cwd: string; response: OfficeRunResponse | null } | null>;
  run: OfficeRunActivity;
  sendOfficeMessage: (text: string) => Promise<void>;
  setActiveTurnByThread: StateSetter<Record<string, string>>;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  setThreads: StateSetter<Thread[]>;
  uniqueId: () => string;
};

export async function handleOfficeRunRetryAction({
  isConnected,
  locale,
  panel,
  recordOfficeRunTurn,
  retryOfficeRun,
  run,
  sendOfficeMessage,
  setActiveTurnByThread,
  setLibraryPanel,
  setNotice,
  setThreads,
  uniqueId,
}: OfficeRunRetryParams): Promise<boolean> {
  const currentPanel = panel();
  if (!currentPanel?.workspace) {
    return false;
  }
  const text = officeRunRetryText(run);
  if (!text) {
    return true;
  }
  if (!isConnected) {
    await sendOfficeMessage(text);
    return true;
  }

  try {
    const retryResult = await retryOfficeRun(
      currentPanel,
      currentPanel.workspace,
      run,
      uniqueId(),
    );
    if (!retryResult?.response) {
      await sendOfficeMessage(text);
      return true;
    }
    const { cwd, response: runResponse } = retryResult;

    recordOfficeRunTurn(
      runResponse.turn.id,
      officeRunTurnRecord(cwd, runResponse),
    );
    setThreads((current) =>
      upsertTurnInThread(current, runResponse.threadId, runResponse.turn),
    );
    setActiveTurnByThread((current) =>
      officeRunActiveTurnByThread(current, runResponse),
    );
    setLibraryPanel((panelBeforeRetry) =>
      officeRunResponsePanel(panelBeforeRetry, runResponse),
    );
  } catch (error) {
    setNotice(officeRunRetryFailureNotice(error, locale));
  }
  return true;
}
