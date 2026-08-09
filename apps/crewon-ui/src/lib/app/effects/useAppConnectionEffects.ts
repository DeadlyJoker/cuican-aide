import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ConversationSummary } from "@crewon-protocol/ConversationSummary";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadGoalView } from "@crewon/contracts";

import {
  AppServerClient,
  type AppServerNotification,
  type AppServerRequest,
} from "../../app-server/appServer";
import {
  runConnectionBootstrapEffectAction,
  scheduleReconnectAction,
} from "../appConnectionActions";
import {
  localizeDemoThreadsAction,
  syncDemoInspectorStateAction,
} from "../appDemoStateActions";
import type { ConnectionState, NoticeState } from "../appRuntimeState";
import type { AccountStatus, GitRemoteDiffSummary } from "../appStatusTypes";
import type { Locale } from "../../i18n";
import type { EmptyThreadSelectionBehavior } from "../../thread/threadModel";
import { createPrincipalSessionProtocols } from "../../app-server/principalSession";

export type AppConnectionEffectsParams = {
  clientRef: MutableRefObject<AppServerClient | null>;
  connectionAttempt: number;
  connectionState: ConnectionState;
  emptySelectionBehavior: EmptyThreadSelectionBehavior;
  handleNotification: (notification: AppServerNotification) => void;
  handleServerRequest: (request: AppServerRequest) => void;
  isDemo: boolean;
  isDemoPreview: boolean;
  locale: Locale;
  manageThreads?: boolean;
  preserveThreadsAfterConnectionLoss: (showConnectionNotice?: boolean) => void;
  principalSessionEnabled: boolean;
  selectedThread: Thread | null;
  selectedThreadId: string | null;
  serverUrl: string;
  setAccountStatus: (accountStatus: AccountStatus | null) => void;
  setConnectionAttempt: (updater: (attempt: number) => number) => void;
  setConnectionState: (state: ConnectionState) => void;
  setConversationSummary: (summary: ConversationSummary | null) => void;
  setGitRemoteDiff: (diff: GitRemoteDiffSummary | null) => void;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: (threadId: string | null) => void;
  setThreadGoal: (goal: ThreadGoalView | null) => void;
  setThreads: Dispatch<SetStateAction<Thread[]>>;
  showArchivedThreadsRef: MutableRefObject<boolean>;
  showDemoThreads: () => void;
  switchToDemoThreads: (showConnectionNotice?: boolean) => void;
};

export function useAppConnectionEffects({
  clientRef,
  connectionAttempt,
  connectionState,
  emptySelectionBehavior,
  handleNotification,
  handleServerRequest,
  isDemo,
  isDemoPreview,
  locale,
  manageThreads = true,
  preserveThreadsAfterConnectionLoss,
  principalSessionEnabled,
  selectedThread,
  selectedThreadId,
  serverUrl,
  setAccountStatus,
  setConnectionAttempt,
  setConnectionState,
  setConversationSummary,
  setGitRemoteDiff,
  setNotice,
  setSelectedThreadId,
  setThreadGoal,
  setThreads,
  showArchivedThreadsRef,
  showDemoThreads,
  switchToDemoThreads,
}: AppConnectionEffectsParams) {
  useEffect(() => {
    return runConnectionBootstrapEffectAction({
      createClient: (onConnectionLost) =>
        new AppServerClient(
          serverUrl,
          handleNotification,
          onConnectionLost,
          handleServerRequest,
          principalSessionEnabled
            ? {
                protocols: () => createPrincipalSessionProtocols(serverUrl),
              }
            : undefined,
        ),
      currentClient: () => clientRef.current,
      emptySelectionBehavior,
      isDemoPreview,
      manageThreads,
      preserveThreadsAfterConnectionLoss,
      setAccountStatus,
      setClient: (client) => {
        clientRef.current = client;
      },
      setConnectionState,
      setNotice,
      selectedThreadId,
      setSelectedThreadId,
      setThreads,
      showArchivedThreads: showArchivedThreadsRef.current,
      showDemoThreads,
      switchToDemoThreads,
    });
  }, [
    connectionAttempt,
    handleNotification,
    handleServerRequest,
    isDemoPreview,
    manageThreads,
    preserveThreadsAfterConnectionLoss,
    principalSessionEnabled,
    serverUrl,
    switchToDemoThreads,
  ]);

  useEffect(() => {
    if (connectionState !== "disconnected") {
      return undefined;
    }

    return scheduleReconnectAction({
      clearTimeout: (timeoutId) => window.clearTimeout(timeoutId),
      client: clientRef.current,
      setConnectionAttempt,
      setConnectionState,
      setTimeout: (handler, timeout) => window.setTimeout(handler, timeout),
    });
  }, [clientRef, connectionState, setConnectionAttempt, setConnectionState]);

  useEffect(() => {
    localizeDemoThreadsAction({
      connectionState,
      locale,
      setThreads,
    });
  }, [connectionState, locale, setThreads]);

  useEffect(() => {
    syncDemoInspectorStateAction({
      isDemo,
      locale,
      selectedThread,
      selectedThreadId,
      setAccountStatus,
      setConversationSummary,
      setGitRemoteDiff,
      setThreadGoal,
    });
  }, [
    isDemo,
    locale,
    selectedThread,
    selectedThreadId,
    setAccountStatus,
    setConversationSummary,
    setGitRemoteDiff,
    setThreadGoal,
  ]);
}
