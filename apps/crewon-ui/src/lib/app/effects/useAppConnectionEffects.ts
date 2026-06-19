import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ConversationSummary } from "@crewon-protocol/ConversationSummary";
import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadGoal } from "@crewon-protocol/v2/ThreadGoal";

import {
  AppServerClient,
  type AppServerNotification,
  type AppServerRequest,
} from "../../app-server/appServer";
import { runConnectionBootstrapEffectAction } from "../appConnectionActions";
import {
  localizeDemoThreadsAction,
  syncDemoInspectorStateAction,
} from "../appDemoStateActions";
import type { ConnectionState, NoticeState } from "../appRuntimeState";
import type {
  AccountStatus,
  GitRemoteDiffSummary,
} from "../appStatusTypes";
import type { Locale } from "../../i18n";

export type AppConnectionEffectsParams = {
  clientRef: MutableRefObject<AppServerClient | null>;
  connectionAttempt: number;
  connectionState: ConnectionState;
  handleNotification: (notification: AppServerNotification) => void;
  handleServerRequest: (request: AppServerRequest) => void;
  isDemo: boolean;
  isDemoPreview: boolean;
  locale: Locale;
  preserveThreadsAfterConnectionLoss: (showConnectionNotice?: boolean) => void;
  selectedThread: Thread | null;
  selectedThreadId: string | null;
  serverUrl: string;
  setAccountStatus: (accountStatus: AccountStatus | null) => void;
  setConnectionState: (state: ConnectionState) => void;
  setConversationSummary: (summary: ConversationSummary | null) => void;
  setGitRemoteDiff: (diff: GitRemoteDiffSummary | null) => void;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: (threadId: string | null) => void;
  setThreadGoal: (goal: ThreadGoal | null) => void;
  setThreads: Dispatch<SetStateAction<Thread[]>>;
  showArchivedThreadsRef: MutableRefObject<boolean>;
  showDemoThreads: () => void;
  switchToDemoThreads: (showConnectionNotice?: boolean) => void;
};

export function useAppConnectionEffects({
  clientRef,
  connectionAttempt,
  connectionState,
  handleNotification,
  handleServerRequest,
  isDemo,
  isDemoPreview,
  locale,
  preserveThreadsAfterConnectionLoss,
  selectedThread,
  selectedThreadId,
  serverUrl,
  setAccountStatus,
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
        ),
      currentClient: () => clientRef.current,
      isDemoPreview,
      preserveThreadsAfterConnectionLoss,
      setAccountStatus,
      setClient: (client) => {
        clientRef.current = client;
      },
      setConnectionState,
      setNotice,
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
    preserveThreadsAfterConnectionLoss,
    serverUrl,
    switchToDemoThreads,
  ]);

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
