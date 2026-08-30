import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import {
  isUnsupportedRpcError,
  type AppServerClient,
  type OfficeMessageSubmitMention,
} from "../../app-server/appServer";
import type {
  LibraryPanel,
  OfficeMember,
  OfficeMemoryStatus,
  OfficeRunActivity,
  OfficeRunDelegationActivity,
  OfficeRunVerificationCheckActivity,
  OfficeWorkspace,
} from "../../domain/crewonDomain";
import {
  cancelAppOfficeDelegation,
  cancelAppOfficeRun,
  cancelAppOfficeVerification,
  decideAppOfficeMemory,
  dispatchAppOfficeDelegation,
  dispatchNextAppOfficeDelegation,
  dispatchNextAppOfficeVerification,
  listAppOfficeMemories,
  previewAppOfficeMemberContext,
  retryAppOfficeDelegation,
  retryAppOfficeVerification,
  retryAppOfficeRun,
  runAppOfficeMessage,
  submitAppOfficeMessage,
} from "../../domain/domainOfficeBackend";
import type { Locale } from "../../i18n";
import type { OfficeRunTurnRecord } from "../../office/officeRunPanel";
import {
  ensureOfficeThreadAction,
  type OfficeThreadResolution,
} from "../../office/officeThreadActions";
import {
  sendOfficeMessageAction,
  type OfficeMessageActionParams,
  type OfficeMessageSendResult,
} from "../../office/officeMessageActions";
import {
  confirmLegacyOfficeIdle as confirmLegacyOfficeIdleFromRuntime,
} from "../../office/officeComposerRuntime";
import { officeMessageMentionsFromText } from "../../office/officeMessageMentions";
import {
  handleOfficeDelegationCancelAction,
  handleOfficeDelegationDispatchAction,
  handleOfficeDelegationDispatchNextAction,
  handleOfficeDelegationRetryAction,
  handleOfficeRunCancelAction,
  handleOfficeRunRetryAction,
  handleOfficeVerificationCancelAction,
  handleOfficeVerificationRetryAction,
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
  ) => Promise<OfficeThreadResolution | null>;
  handleOfficeDelegationDispatch: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => Promise<void>;
  handleOfficeDelegationCancel: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => Promise<void>;
  handleOfficeDelegationRetry: (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => Promise<void>;
  handleOfficeDelegationDispatchNext: (run: OfficeRunActivity) => Promise<void>;
  handleOfficeVerificationCancel: (
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
  ) => Promise<void>;
  handleOfficeVerificationRetry: (
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
  ) => Promise<void>;
  handleOfficeRunCancel: (run: OfficeRunActivity) => Promise<void>;
  handleOfficeRunRetry: (run: OfficeRunActivity) => Promise<void>;
  listOfficeMemories: (
    status: OfficeMemoryStatus,
    cursor?: string | null,
  ) => ReturnType<typeof listAppOfficeMemories>;
  decideOfficeMemory: (
    memoryId: string,
    status: OfficeMemoryStatus,
  ) => ReturnType<typeof decideAppOfficeMemory>;
  previewOfficeMemberContext: (
    run: OfficeRunActivity,
    member: OfficeMember,
  ) => ReturnType<typeof previewAppOfficeMemberContext>;
  recordOfficeRunTurn: (turnId: string, record: OfficeRunTurnRecord) => void;
  sendOfficeMessage: (
    text: string,
    clientUserMessageId?: string,
    mentions?: OfficeMessageSubmitMention[],
  ) => Promise<OfficeMessageSendResult>;
};

export type AppOfficeRuntimeHandlersParams = {
  client: AppServerClient | null;
  getActiveTurnByThread: () => Record<string, string>;
  getLibraryPanel: () => LibraryPanel | null;
  isConnected: boolean;
  isMissingThreadError: (error: unknown) => boolean;
  isUnsupportedRpcError?: (error: unknown) => boolean;
  locale: Locale;
  persistOfficeMessage: OfficeMessageActionParams["persistOfficeMessage"];
  recordOfficeRunTurn: (turnId: string, record: OfficeRunTurnRecord) => void;
  resolveBackendCwd: () => Promise<string>;
  setActiveTurnByThread: ActiveTurnSetter;
  setLibraryPanel: LibraryPanelSetter;
  setNotice: (notice: NoticeState | null) => void;
  setThreads: ThreadSetter;
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
      ensureOfficeManager: async (officeRecordId, expectedRecordRevision) => {
        const cwd = panel.workspaceCwd?.trim() || (await params.resolveBackendCwd());
        return (
          (await params.client?.ensureOfficeManagerConfig(
            cwd,
            officeRecordId,
            expectedRecordRevision,
          )) ?? null
        );
      },
      readThread: (threadId) =>
        params.client?.readThread(threadId) ?? Promise.resolve(null),
      setLibraryPanel: params.setLibraryPanel,
      setThreads: params.setThreads,
      workspaceOverride,
    });

  const sendOfficeMessage = async (
    text: string,
    clientUserMessageId = `office-message-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`}`,
    mentions: OfficeMessageSubmitMention[] = [],
  ) => {
    return sendOfficeMessageAction({
      clientUserMessageId,
      confirmLegacyOfficeIdle: (workspace) =>
        confirmLegacyOfficeIdleFromRuntime({
          activeTurnByThread: params.getActiveTurnByThread(),
          isMissingThreadError: params.isMissingThreadError,
          readThread: (threadId) =>
            params.client?.readThread(threadId) ?? Promise.resolve(null),
          workspace,
        }),
      ensureOfficeThread,
      isConnected: params.isConnected,
      isMissingThreadError: params.isMissingThreadError,
      isUnsupportedRpcError:
        params.isUnsupportedRpcError ?? isUnsupportedRpcError,
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
        messageClientUserMessageId,
      ) =>
        runAppOfficeMessage({
          client: params.client,
          clientUserMessageId: messageClientUserMessageId,
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
      submitOfficeMessage: (
        targetPanel,
        workspace,
        messageText,
        messageClientUserMessageId,
      ) =>
        submitAppOfficeMessage({
          client: params.client,
          clientUserMessageId: messageClientUserMessageId,
          locale: params.locale,
          mentions:
            mentions.length > 0
              ? mentions
              : officeMessageMentionsFromText(
                  messageText,
                  workspace.members,
                ),
          panel: targetPanel,
          resolveBackendCwd: params.resolveBackendCwd,
          text: messageText,
          workspace,
        }),
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
      dispatchNextOfficeVerification: (
        panel,
        workspace,
        targetRun,
        clientUserMessageId,
      ) =>
        dispatchNextAppOfficeVerification({
          clientUserMessageId,
          client: params.client,
          locale: params.locale,
          panel,
          resolveBackendCwd: params.resolveBackendCwd,
          run: targetRun,
          workspace,
        }),
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
      sendOfficeMessage: async (text) => {
        await sendOfficeMessage(text);
      },
      setActiveTurnByThread: params.setActiveTurnByThread,
      setLibraryPanel: params.setLibraryPanel,
      setNotice: params.setNotice,
      setThreads: params.setThreads,
      uniqueId:
        params.uniqueOfficeRunId ?? (() => `office-retry-${Date.now()}`),
    });
  };

  const handleOfficeDelegationCancel = async (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => {
    await handleOfficeDelegationCancelAction({
      cancelOfficeDelegation: (panel, workspace, targetRun, targetDelegation) =>
        cancelAppOfficeDelegation({
          client: params.client,
          delegation: targetDelegation,
          locale: params.locale,
          panel,
          resolveBackendCwd: params.resolveBackendCwd,
          run: targetRun,
          workspace,
        }),
      delegation,
      isConnected: params.isConnected,
      locale: params.locale,
      panel: params.getLibraryPanel,
      run,
      setLibraryPanel: params.setLibraryPanel,
      setNotice: params.setNotice,
    });
  };

  const handleOfficeVerificationCancel = async (
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
  ) => {
    await handleOfficeVerificationCancelAction({
      cancelOfficeVerification: (panel, workspace, targetRun, targetCheck) =>
        cancelAppOfficeVerification({
          check: targetCheck,
          client: params.client,
          locale: params.locale,
          panel,
          resolveBackendCwd: params.resolveBackendCwd,
          run: targetRun,
          workspace,
        }),
      check,
      isConnected: params.isConnected,
      locale: params.locale,
      panel: params.getLibraryPanel,
      run,
      setLibraryPanel: params.setLibraryPanel,
      setNotice: params.setNotice,
    });
  };

  const handleOfficeVerificationRetry = async (
    run: OfficeRunActivity,
    check: OfficeRunVerificationCheckActivity,
  ) => {
    await handleOfficeVerificationRetryAction({
      check,
      isConnected: params.isConnected,
      locale: params.locale,
      panel: params.getLibraryPanel,
      recordOfficeRunTurn: params.recordOfficeRunTurn,
      retryOfficeVerification: (
        panel,
        workspace,
        targetRun,
        targetCheck,
        clientUserMessageId,
      ) =>
        retryAppOfficeVerification({
          check: targetCheck,
          client: params.client,
          clientUserMessageId,
          locale: params.locale,
          panel,
          resolveBackendCwd: params.resolveBackendCwd,
          run: targetRun,
          workspace,
        }),
      run,
      setActiveTurnByThread: params.setActiveTurnByThread,
      setLibraryPanel: params.setLibraryPanel,
      setNotice: params.setNotice,
      setThreads: params.setThreads,
      uniqueId:
        params.uniqueOfficeRunId ??
        (() => `office-verification-retry-${Date.now()}`),
    });
  };

  const handleOfficeDelegationDispatch = async (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => {
    await handleOfficeDelegationDispatchAction({
      delegation,
      dispatchOfficeDelegation: (
        panel,
        workspace,
        targetRun,
        targetDelegation,
        clientUserMessageId,
      ) =>
        dispatchAppOfficeDelegation({
          client: params.client,
          clientUserMessageId,
          agentId: targetDelegation.agentId ?? null,
          locale: params.locale,
          member: targetDelegation.member ?? null,
          panel,
          resolveBackendCwd: params.resolveBackendCwd,
          run: targetRun,
          task: targetDelegation.task?.trim() ?? "",
          workspace,
        }),
      isConnected: params.isConnected,
      locale: params.locale,
      panel: params.getLibraryPanel,
      recordOfficeRunTurn: params.recordOfficeRunTurn,
      run,
      setActiveTurnByThread: params.setActiveTurnByThread,
      setLibraryPanel: params.setLibraryPanel,
      setNotice: params.setNotice,
      setThreads: params.setThreads,
      uniqueId:
        params.uniqueOfficeRunId ?? (() => `office-delegation-${Date.now()}`),
    });
  };

  const handleOfficeDelegationRetry = async (
    run: OfficeRunActivity,
    delegation: OfficeRunDelegationActivity,
  ) => {
    await handleOfficeDelegationRetryAction({
      delegation,
      isConnected: params.isConnected,
      locale: params.locale,
      panel: params.getLibraryPanel,
      recordOfficeRunTurn: params.recordOfficeRunTurn,
      retryOfficeDelegation: (
        panel,
        workspace,
        targetRun,
        targetDelegation,
        clientUserMessageId,
      ) =>
        retryAppOfficeDelegation({
          client: params.client,
          clientUserMessageId,
          delegation: targetDelegation,
          locale: params.locale,
          panel,
          resolveBackendCwd: params.resolveBackendCwd,
          run: targetRun,
          workspace,
        }),
      run,
      setActiveTurnByThread: params.setActiveTurnByThread,
      setLibraryPanel: params.setLibraryPanel,
      setNotice: params.setNotice,
      setThreads: params.setThreads,
      uniqueId:
        params.uniqueOfficeRunId ?? (() => `office-delegation-retry-${Date.now()}`),
    });
  };

  const handleOfficeDelegationDispatchNext = async (run: OfficeRunActivity) => {
    await handleOfficeDelegationDispatchNextAction({
      dispatchNextOfficeDelegation: (
        panel,
        workspace,
        targetRun,
        clientUserMessageId,
      ) =>
        dispatchNextAppOfficeDelegation({
          client: params.client,
          clientUserMessageId,
          locale: params.locale,
          panel,
          resolveBackendCwd: params.resolveBackendCwd,
          run: targetRun,
          workspace,
        }),
      isConnected: params.isConnected,
      locale: params.locale,
      panel: params.getLibraryPanel,
      recordOfficeRunTurn: params.recordOfficeRunTurn,
      run,
      setActiveTurnByThread: params.setActiveTurnByThread,
      setLibraryPanel: params.setLibraryPanel,
      setNotice: params.setNotice,
      setThreads: params.setThreads,
      uniqueId:
        params.uniqueOfficeRunId ?? (() => `office-delegation-${Date.now()}`),
    });
  };

  const listOfficeMemories = (
    status: OfficeMemoryStatus,
    cursor?: string | null,
  ) => {
    const panel = params.getLibraryPanel();
    if (!panel?.workspace) {
      return Promise.resolve(null);
    }
    return listAppOfficeMemories({
      client: params.client,
      cursor: cursor ?? null,
      limit: 24,
      panel,
      resolveBackendCwd: params.resolveBackendCwd,
      status,
      threadId: panel.workspace.threadId ?? "",
      workspace: panel.workspace,
    });
  };

  const decideOfficeMemory = (memoryId: string, status: OfficeMemoryStatus) => {
    const panel = params.getLibraryPanel();
    if (!panel?.workspace) {
      return Promise.resolve(null);
    }
    return decideAppOfficeMemory({
      client: params.client,
      memoryId,
      panel,
      resolveBackendCwd: params.resolveBackendCwd,
      status,
      threadId: panel.workspace.threadId ?? "",
      workspace: panel.workspace,
    });
  };

  const previewOfficeMemberContext = (
    run: OfficeRunActivity,
    member: OfficeMember,
  ) => {
    const panel = params.getLibraryPanel();
    if (!panel?.workspace) {
      return Promise.resolve(null);
    }
    return previewAppOfficeMemberContext({
      agentId: member.agentId ?? null,
      client: params.client,
      locale: params.locale,
      member: member.name,
      panel,
      resolveBackendCwd: params.resolveBackendCwd,
      run,
      task: run.title ?? run.requestText ?? null,
      workspace: panel.workspace,
    });
  };

  return {
    decideOfficeMemory,
    ensureOfficeThread,
    handleOfficeDelegationCancel,
    handleOfficeDelegationDispatch,
    handleOfficeDelegationDispatchNext,
    handleOfficeDelegationRetry,
    handleOfficeVerificationCancel,
    handleOfficeVerificationRetry,
    handleOfficeRunCancel,
    handleOfficeRunRetry,
    listOfficeMemories,
    previewOfficeMemberContext,
    recordOfficeRunTurn: params.recordOfficeRunTurn,
    sendOfficeMessage,
  };
}
