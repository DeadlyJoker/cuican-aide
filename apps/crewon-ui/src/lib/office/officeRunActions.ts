import type { Thread } from "@crewon-protocol/v2/Thread";

import type {
  OfficeDelegationCancelResponse,
  OfficeDelegationDispatchResponse,
  OfficeDelegationRetryResponse,
  OfficeVerificationCancelResponse,
  OfficeVerificationRetryResponse,
  OfficeRunResponse,
} from "../app-server/appServer";
import type { NoticeState } from "../shared/noticeState";
import type {
  LibraryPanel,
  OfficeConfig,
  OfficeRunActivity,
  OfficeRunDelegationActivity,
  OfficeRunVerificationCheckActivity,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  officeChildCancelFailureNotice,
  officeChildCancelUnavailableNoticeState,
  officeDelegationDispatchFailureNotice,
  officeDelegationDispatchUnavailableNoticeState,
  officeDelegationRetryFailureNotice,
  officeDelegationRetryUnavailableNoticeState,
  officeRunActiveTurnByThread,
  officeRunCanceledPanel,
  officeRunCancelFailureNotice,
  officeRunCancelingPanel,
  officeRunCancelRollbackPanel,
  officeRunCancelUnavailableNoticeState,
  officeRunCancelUnsupportedNoticeState,
  officeRunResponsePanel,
  officeRunRetryFailureNotice,
  officeRunRetryLimitNotice,
  officeRunRetryLimitReached,
  officeRunRetryText,
  officeRunSyncedPanel,
  officeRunTurnRecord,
  officeVerificationRetryFailureNotice,
  officeVerificationRetryUnavailableNoticeState,
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

export type OfficeDelegationCancelParams = {
  cancelOfficeDelegation: (
    panel: LibraryPanel,
    workspace: NonNullable<LibraryPanel["workspace"]>,
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => Promise<{
    cwd: string;
    response: OfficeDelegationCancelResponse | null;
  } | null>;
  delegation: OfficeRunDelegationActivity;
  isConnected: boolean;
  locale: Locale;
  panel: OfficeRunActionPanelProvider;
  run: OfficeRunActivity;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
};

export type OfficeVerificationCancelParams = {
  cancelOfficeVerification: (
    panel: LibraryPanel,
    workspace: NonNullable<LibraryPanel["workspace"]>,
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
  ) => Promise<{
    cwd: string;
    response: OfficeVerificationCancelResponse | null;
  } | null>;
  check: OfficeRunVerificationCheckActivity;
  isConnected: boolean;
  locale: Locale;
  panel: OfficeRunActionPanelProvider;
  run: OfficeRunActivity;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
};

export type OfficeVerificationRetryParams = {
  retryOfficeVerification: (
    panel: LibraryPanel,
    workspace: NonNullable<LibraryPanel["workspace"]>,
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
    clientUserMessageId: string,
  ) => Promise<{
    cwd: string;
    response: OfficeVerificationRetryResponse | null;
  } | null>;
  check: OfficeRunVerificationCheckActivity;
  isConnected: boolean;
  locale: Locale;
  panel: OfficeRunActionPanelProvider;
  recordOfficeRunTurn: (turnId: string, record: OfficeRunTurnRecord) => void;
  run: OfficeRunActivity;
  setActiveTurnByThread: StateSetter<Record<string, string>>;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  setThreads: StateSetter<Thread[]>;
  uniqueId: () => string;
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
    const config = await cancelOfficeRun(
      currentPanel,
      currentPanel.workspace,
      run,
    );
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

export async function handleOfficeDelegationCancelAction({
  cancelOfficeDelegation,
  delegation,
  isConnected,
  locale,
  panel,
  run,
  setLibraryPanel,
  setNotice,
}: OfficeDelegationCancelParams): Promise<boolean> {
  const currentPanel = panel();
  if (!currentPanel?.workspace) {
    return false;
  }
  const threadId = run.threadId ?? currentPanel.workspace.threadId;
  if (
    !isConnected ||
    !threadId ||
    !delegation.id ||
    !delegation.turnId ||
    !delegation.threadId
  ) {
    setNotice(officeChildCancelUnavailableNoticeState(locale));
    return true;
  }

  try {
    const result = await cancelOfficeDelegation(
      currentPanel,
      currentPanel.workspace,
      run,
      delegation,
    );
    const response = result?.response;
    if (!result || !response) {
      setNotice(officeChildCancelUnavailableNoticeState(locale));
      return true;
    }
    setLibraryPanel((panelBeforeUpdate) =>
      officeRunSyncedPanel(panelBeforeUpdate, {
        config: response.config,
        threadId,
      }),
    );
  } catch (error) {
    setNotice(officeChildCancelFailureNotice(error, locale));
  }
  return true;
}

export async function handleOfficeVerificationCancelAction({
  cancelOfficeVerification,
  check,
  isConnected,
  locale,
  panel,
  run,
  setLibraryPanel,
  setNotice,
}: OfficeVerificationCancelParams): Promise<boolean> {
  const currentPanel = panel();
  if (!currentPanel?.workspace) {
    return false;
  }
  const threadId = run.threadId ?? currentPanel.workspace.threadId;
  const turnId = check.automationTurnId ?? check.sourceTurnId;
  const checkId = check.itemId ?? check.automationId ?? check.check;
  if (!isConnected || !threadId || !turnId || !checkId.trim()) {
    setNotice(officeChildCancelUnavailableNoticeState(locale));
    return true;
  }

  try {
    const result = await cancelOfficeVerification(
      currentPanel,
      currentPanel.workspace,
      run,
      check,
    );
    const response = result?.response;
    if (!result || !response) {
      setNotice(officeChildCancelUnavailableNoticeState(locale));
      return true;
    }
    setLibraryPanel((panelBeforeUpdate) =>
      officeRunSyncedPanel(panelBeforeUpdate, {
        config: response.config,
        threadId,
      }),
    );
  } catch (error) {
    setNotice(officeChildCancelFailureNotice(error, locale));
  }
  return true;
}

export async function handleOfficeVerificationRetryAction({
  check,
  isConnected,
  locale,
  panel,
  recordOfficeRunTurn,
  retryOfficeVerification,
  run,
  setActiveTurnByThread,
  setLibraryPanel,
  setNotice,
  setThreads,
  uniqueId,
}: OfficeVerificationRetryParams): Promise<boolean> {
  const currentPanel = panel();
  if (!currentPanel?.workspace) {
    return false;
  }
  const checkId = check.itemId ?? check.automationId ?? check.check;
  if (
    !isConnected ||
    !checkId?.trim() ||
    !check.automationId?.trim() ||
    !verificationCheckAllowsRetry(check)
  ) {
    setNotice(officeVerificationRetryUnavailableNoticeState(locale));
    return true;
  }

  try {
    const retryResult = await retryOfficeVerification(
      currentPanel,
      currentPanel.workspace,
      run,
      check,
      uniqueId(),
    );
    const response = retryResult?.response;
    if (!retryResult || !response) {
      setNotice(officeVerificationRetryUnavailableNoticeState(locale));
      return true;
    }
    recordOfficeRunTurn(
      response.turn.id,
      officeRunTurnRecord(retryResult.cwd, response),
    );
    setThreads((current) =>
      upsertTurnInThread(current, response.threadId, response.turn),
    );
    setActiveTurnByThread((current) =>
      officeRunActiveTurnByThread(current, response),
    );
    setLibraryPanel((panelBeforeRetry) =>
      officeRunResponsePanel(panelBeforeRetry, response),
    );
  } catch (error) {
    setNotice(officeVerificationRetryFailureNotice(error, locale));
  }
  return true;
}

function verificationCheckAllowsRetry(
  check: OfficeRunVerificationCheckActivity,
): boolean {
  const status = check.status ?? "";
  const dispatchStatus = check.dispatchStatus ?? "";
  const automationStatus = check.automationStatus ?? "";
  return (
    !["queued", "running", "canceling"].includes(dispatchStatus) &&
    (["failed", "interrupted"].includes(status) ||
      ["failed", "interrupted"].includes(dispatchStatus) ||
      ["failed", "interrupted"].includes(automationStatus))
  );
}

export type OfficeRunRetryParams = {
  dispatchNextOfficeVerification?: (
    panel: LibraryPanel,
    workspace: NonNullable<LibraryPanel["workspace"]>,
    run: OfficeRunActivity,
    clientUserMessageId: string,
  ) => Promise<{ cwd: string; response: OfficeRunResponse | null } | null>;
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
  dispatchNextOfficeVerification,
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
  if (officeRunRetryLimitReached(run)) {
    setNotice(officeRunRetryLimitNotice(locale));
    return true;
  }
  const text = officeRunRetryText(run, locale);
  if (!text) {
    return true;
  }
  if (!isConnected) {
    await sendOfficeMessage(text);
    return true;
  }

  try {
    if (
      dispatchNextOfficeVerification &&
      run.loop?.review?.nextAction === "runVerificationChecks" &&
      hasDispatchableAutomationVerification(run)
    ) {
      const verificationResult = await dispatchNextOfficeVerification(
        currentPanel,
        currentPanel.workspace,
        run,
        uniqueId(),
      );
      if (verificationResult?.response) {
        const { cwd, response: runResponse } = verificationResult;

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
        return true;
      }
    }
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

function hasDispatchableAutomationVerification(
  run: OfficeRunActivity,
): boolean {
  return Boolean(
    run.verificationChecks?.some((check) => {
      const status = check.status ?? "pending";
      const dispatchStatus = check.dispatchStatus ?? "";
      return (
        status === "pending" &&
        Boolean(check.automationId?.trim()) &&
        !check.automationTurnId &&
        !check.automationRunId &&
        !["queued", "running", "canceling", "completed"].includes(
          dispatchStatus,
        )
      );
    }),
  );
}

export type OfficeDelegationDispatchParams = {
  delegation: OfficeRunDelegationActivity;
  dispatchOfficeDelegation: (
    panel: LibraryPanel,
    workspace: NonNullable<LibraryPanel["workspace"]>,
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
    clientUserMessageId: string,
  ) => Promise<{
    cwd: string;
    response: OfficeDelegationDispatchResponse | null;
  } | null>;
  isConnected: boolean;
  locale: Locale;
  panel: OfficeRunActionPanelProvider;
  recordOfficeRunTurn: (turnId: string, record: OfficeRunTurnRecord) => void;
  run: OfficeRunActivity;
  setActiveTurnByThread: StateSetter<Record<string, string>>;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  setThreads: StateSetter<Thread[]>;
  uniqueId: () => string;
};

export type OfficeDelegationDispatchNextParams = {
  dispatchNextOfficeDelegation: (
    panel: LibraryPanel,
    workspace: NonNullable<LibraryPanel["workspace"]>,
    run: OfficeRunActivity,
    clientUserMessageId: string,
  ) => Promise<{
    cwd: string;
    response: OfficeDelegationDispatchResponse | null;
  } | null>;
  isConnected: boolean;
  locale: Locale;
  panel: OfficeRunActionPanelProvider;
  recordOfficeRunTurn: (turnId: string, record: OfficeRunTurnRecord) => void;
  run: OfficeRunActivity;
  setActiveTurnByThread: StateSetter<Record<string, string>>;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  setThreads: StateSetter<Thread[]>;
  uniqueId: () => string;
};

export type OfficeDelegationRetryParams = {
  delegation: OfficeRunDelegationActivity;
  retryOfficeDelegation: (
    panel: LibraryPanel,
    workspace: NonNullable<LibraryPanel["workspace"]>,
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
    clientUserMessageId: string,
  ) => Promise<{
    cwd: string;
    response: OfficeDelegationRetryResponse | null;
  } | null>;
  isConnected: boolean;
  locale: Locale;
  panel: OfficeRunActionPanelProvider;
  recordOfficeRunTurn: (turnId: string, record: OfficeRunTurnRecord) => void;
  run: OfficeRunActivity;
  setActiveTurnByThread: StateSetter<Record<string, string>>;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  setThreads: StateSetter<Thread[]>;
  uniqueId: () => string;
};

export async function handleOfficeDelegationDispatchAction({
  delegation,
  dispatchOfficeDelegation,
  isConnected,
  locale,
  panel,
  recordOfficeRunTurn,
  run,
  setActiveTurnByThread,
  setLibraryPanel,
  setNotice,
  setThreads,
  uniqueId,
}: OfficeDelegationDispatchParams): Promise<boolean> {
  const currentPanel = panel();
  if (!currentPanel?.workspace) {
    return false;
  }
  if (
    !isConnected ||
    !delegation.task?.trim() ||
    (!delegation.member && !delegation.agentId)
  ) {
    setNotice(officeDelegationDispatchUnavailableNoticeState(locale));
    return true;
  }

  try {
    const dispatchResult = await dispatchOfficeDelegation(
      currentPanel,
      currentPanel.workspace,
      run,
      delegation,
      uniqueId(),
    );
    const response = dispatchResult?.response;
    if (!dispatchResult || !response) {
      setNotice(officeDelegationDispatchUnavailableNoticeState(locale));
      return true;
    }
    applyDelegationDispatchResult({
      dispatchResult: { ...dispatchResult, response },
      recordOfficeRunTurn,
      setActiveTurnByThread,
      setLibraryPanel,
      setThreads,
    });
  } catch (error) {
    setNotice(officeDelegationDispatchFailureNotice(error, locale));
  }
  return true;
}

export async function handleOfficeDelegationRetryAction({
  delegation,
  isConnected,
  locale,
  panel,
  recordOfficeRunTurn,
  retryOfficeDelegation,
  run,
  setActiveTurnByThread,
  setLibraryPanel,
  setNotice,
  setThreads,
  uniqueId,
}: OfficeDelegationRetryParams): Promise<boolean> {
  const currentPanel = panel();
  if (!currentPanel?.workspace) {
    return false;
  }
  if (
    !isConnected ||
    !delegation.id ||
    !["failed", "interrupted"].includes(delegation.status ?? "")
  ) {
    setNotice(officeDelegationRetryUnavailableNoticeState(locale));
    return true;
  }

  try {
    const retryResult = await retryOfficeDelegation(
      currentPanel,
      currentPanel.workspace,
      run,
      delegation,
      uniqueId(),
    );
    const response = retryResult?.response;
    if (!retryResult || !response) {
      setNotice(officeDelegationRetryUnavailableNoticeState(locale));
      return true;
    }
    applyDelegationDispatchResult({
      dispatchResult: { ...retryResult, response },
      recordOfficeRunTurn,
      setActiveTurnByThread,
      setLibraryPanel,
      setThreads,
    });
  } catch (error) {
    setNotice(officeDelegationRetryFailureNotice(error, locale));
  }
  return true;
}

export async function handleOfficeDelegationDispatchNextAction({
  dispatchNextOfficeDelegation,
  isConnected,
  locale,
  panel,
  recordOfficeRunTurn,
  run,
  setActiveTurnByThread,
  setLibraryPanel,
  setNotice,
  setThreads,
  uniqueId,
}: OfficeDelegationDispatchNextParams): Promise<boolean> {
  const currentPanel = panel();
  if (!currentPanel?.workspace) {
    return false;
  }
  if (!isConnected) {
    setNotice(officeDelegationDispatchUnavailableNoticeState(locale));
    return true;
  }

  try {
    const dispatchResult = await dispatchNextOfficeDelegation(
      currentPanel,
      currentPanel.workspace,
      run,
      uniqueId(),
    );
    const response = dispatchResult?.response;
    if (!dispatchResult || !response) {
      setNotice(officeDelegationDispatchUnavailableNoticeState(locale));
      return true;
    }
    applyDelegationDispatchResult({
      dispatchResult: { ...dispatchResult, response },
      recordOfficeRunTurn,
      setActiveTurnByThread,
      setLibraryPanel,
      setThreads,
    });
  } catch (error) {
    setNotice(officeDelegationDispatchFailureNotice(error, locale));
  }
  return true;
}

function applyDelegationDispatchResult({
  dispatchResult,
  recordOfficeRunTurn,
  setActiveTurnByThread,
  setLibraryPanel,
  setThreads,
}: {
  dispatchResult: {
    cwd: string;
    response: OfficeDelegationDispatchResponse | OfficeDelegationRetryResponse;
  };
  recordOfficeRunTurn: (turnId: string, record: OfficeRunTurnRecord) => void;
  setActiveTurnByThread: StateSetter<Record<string, string>>;
  setLibraryPanel: LibraryPanelSetter;
  setThreads: StateSetter<Thread[]>;
}): void {
  const { cwd, response } = dispatchResult;
  recordOfficeRunTurn(response.turn.id, officeRunTurnRecord(cwd, response));
  setThreads((current) =>
    upsertTurnInThread(current, response.threadId, response.turn),
  );
  setActiveTurnByThread((current) =>
    officeRunActiveTurnByThread(current, response),
  );
  setLibraryPanel((panelBeforeDispatch) =>
    officeRunResponsePanel(panelBeforeDispatch, response),
  );
}
