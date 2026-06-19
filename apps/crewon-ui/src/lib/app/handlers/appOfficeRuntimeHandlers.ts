import type { Thread } from "@crewon-protocol/v2/Thread";

import type { AppServerClient } from "../../app-server/appServer";
import { appendOfficeUserMessage } from "../../demo/demoContent";
import type {
  LibraryPanel,
  OfficeRunActivity,
  OfficeWorkspace,
} from "../../domain/crewonDomain";
import {
  cancelAppOfficeRun,
  retryAppOfficeRun,
  runAppOfficeMessage,
} from "../../domain/domainOfficeBackend";
import type { Locale } from "../../i18n";
import type { OfficeRunTurnRecord } from "../../office/officeRunPanel";
import {
  ensureOfficeThreadAction,
  type EnsureOfficeThreadActionParams,
} from "../../office/officeThreadActions";
import {
  sendOfficeMessageAction,
  type OfficeMessageActionParams,
} from "../../office/officeMessageActions";
import {
  handleOfficeRunCancelAction,
  handleOfficeRunRetryAction,
} from "../../office/officeRunActions";
import type { NoticeState } from "../appRuntimeState";

type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;
type ThreadSetter = (updater: (currentThreads: Thread[]) => Thread[]) => void;
type ActiveTurnSetter = (
  updater: (current: Record<string, string>) => Record<string, string>,
) => void;

export type AppOfficeRuntimeHandlers = {
  ensureOfficeThread: (
    panel: LibraryPanel,
    workspaceOverride?: OfficeWorkspace,
    forceNew?: boolean,
  ) => Promise<string | null>;
  handleOfficeRunCancel: (run: OfficeRunActivity) => Promise<void>;
  handleOfficeRunRetry: (run: OfficeRunActivity) => Promise<void>;
  sendOfficeMessage: (text: string) => Promise<void>;
};

export type AppOfficeRuntimeHandlersParams = {
  client: AppServerClient | null;
  getLibraryPanel: () => LibraryPanel | null;
  isConnected: boolean;
  isMissingThreadError: (error: unknown) => boolean;
  locale: Locale;
  persistOfficeMessage: OfficeMessageActionParams["persistOfficeMessage"];
  persistOfficeWorkspace: EnsureOfficeThreadActionParams["persistOfficeWorkspace"];
  recordOfficeRunTurn: (turnId: string, record: OfficeRunTurnRecord) => void;
  resolveBackendCwd: () => Promise<string>;
  setActiveTurnByThread: ActiveTurnSetter;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  setThreads: ThreadSetter;
  startBackendDomainThread: (
    source: "agent" | "automation" | "office",
  ) => Promise<Thread | null>;
  uniqueOfficeRunId?: () => string;
};

export function createAppOfficeRuntimeHandlers(
  params: AppOfficeRuntimeHandlersParams,
): AppOfficeRuntimeHandlers {
  const ensureOfficeThread = (
    panel: LibraryPanel,
    workspaceOverride?: OfficeWorkspace,
    forceNew?: boolean,
  ) =>
    ensureOfficeThreadAction({
      forceNew,
      isConnected: params.isConnected,
      isMissingThreadError: params.isMissingThreadError,
      locale: params.locale,
      panel,
      persistOfficeWorkspace: params.persistOfficeWorkspace,
      readThread: (threadId) =>
        params.client?.readThread(threadId) ?? Promise.resolve(null),
      renameThread: async (threadId, title) => {
        await params.client?.renameThread(threadId, title);
      },
      setLibraryPanel: params.setLibraryPanel,
      setThreadGoal: async (threadId, goal, tokenBudget) => {
        await params.client?.setThreadGoal(threadId, goal, tokenBudget);
      },
      setThreads: params.setThreads,
      startOfficeThread: () => params.startBackendDomainThread("office"),
      startTurn: (threadId, text) =>
        params.client?.startTurn(threadId, text) ?? Promise.resolve(null),
      workspaceOverride,
    });

  const sendOfficeMessage = async (text: string) => {
    await sendOfficeMessageAction({
      appendDisconnectedMessage: appendOfficeUserMessage,
      ensureOfficeThread,
      isConnected: params.isConnected,
      isMissingThreadError: params.isMissingThreadError,
      locale: params.locale,
      panel: params.getLibraryPanel(),
      persistOfficeMessage: params.persistOfficeMessage,
      recordOfficeRunTurn: params.recordOfficeRunTurn,
      runOfficeMessage: (
        panel,
        workspaceBeforeMessage,
        message,
        messageText,
        threadId,
        fallbackWorkspace,
      ) =>
        runAppOfficeMessage({
          client: params.client,
          fallbackWorkspace,
          locale: params.locale,
          message,
          panel,
          resolveBackendCwd: params.resolveBackendCwd,
          text: messageText,
          threadId,
          workspaceBeforeMessage,
        }),
      setActiveTurnByThread: params.setActiveTurnByThread,
      setLibraryPanel: params.setLibraryPanel,
      setThreads: params.setThreads,
      startTurn: (threadId, input) =>
        params.client?.startTurn(threadId, input) ?? Promise.resolve(null),
      text,
    });
  };

  const handleOfficeRunCancel = async (run: OfficeRunActivity) => {
    await handleOfficeRunCancelAction({
      cancelOfficeRun: (panel, workspace, targetRun) =>
        cancelAppOfficeRun({
          client: params.client,
          locale: params.locale,
          panel,
          resolveBackendCwd: params.resolveBackendCwd,
          run: targetRun,
          workspace,
        }),
      isConnected: params.isConnected,
      locale: params.locale,
      panel: params.getLibraryPanel,
      run,
      setLibraryPanel: params.setLibraryPanel,
      setNotice: params.setNotice,
    });
  };

  const handleOfficeRunRetry = async (run: OfficeRunActivity) => {
    await handleOfficeRunRetryAction({
      isConnected: params.isConnected,
      locale: params.locale,
      panel: params.getLibraryPanel,
      recordOfficeRunTurn: params.recordOfficeRunTurn,
      retryOfficeRun: (panel, workspace, targetRun, clientUserMessageId) =>
        retryAppOfficeRun({
          clientUserMessageId,
          client: params.client,
          locale: params.locale,
          panel,
          resolveBackendCwd: params.resolveBackendCwd,
          run: targetRun,
          workspace,
        }),
      run,
      sendOfficeMessage,
      setActiveTurnByThread: params.setActiveTurnByThread,
      setLibraryPanel: params.setLibraryPanel,
      setNotice: params.setNotice,
      setThreads: params.setThreads,
      uniqueId: params.uniqueOfficeRunId ?? (() => `office-retry-${Date.now()}`),
    });
  };

  return {
    ensureOfficeThread,
    handleOfficeRunCancel,
    handleOfficeRunRetry,
    sendOfficeMessage,
  };
}
