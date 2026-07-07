import type { MutableRefObject } from "react";
import type { Thread } from "@crewon-protocol/v2/Thread";

import type { AppServerClient } from "../../app-server/appServer";
import {
  preserveThreadsAfterConnectionLossAction,
  retryConnectionAction,
  showDemoThreadsAction,
  switchToDemoThreadsAction,
} from "../appConnectionActions";
import type { ConnectionState, NoticeState } from "../appRuntimeState";
import { getDemoThreads } from "../../demo/demoData";
import { translate, type Locale } from "../../i18n";

export type AppConnectionHandlers = {
  preserveThreadsAfterConnectionLoss: (showConnectionNotice?: boolean) => void;
  retryConnection: () => void;
  showDemoThreads: () => void;
  switchToDemoThreads: (showConnectionNotice?: boolean) => void;
};

export type AppConnectionHandlersParams = {
  getClient: () => AppServerClient | null;
  localeRef: MutableRefObject<Locale>;
  setConnectionAttempt: (updater: (attempt: number) => number) => void;
  setConnectionState: (state: ConnectionState) => void;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: (threadId: string | null) => void;
  setStreamingTextByThread: (streamingTextByThread: Record<string, string>) => void;
  setThreads: (threads: Thread[]) => void;
};

export function createAppConnectionHandlers({
  getClient,
  localeRef,
  setConnectionAttempt,
  setConnectionState,
  setNotice,
  setSelectedThreadId,
  setStreamingTextByThread,
  setThreads,
}: AppConnectionHandlersParams): AppConnectionHandlers {
  const demoThreads = () => getDemoThreads(localeRef.current);
  const connectionLostMessage = () =>
    translate(localeRef.current).connectionLost;

  return {
    preserveThreadsAfterConnectionLoss: (showConnectionNotice = true) => {
      preserveThreadsAfterConnectionLossAction({
        connectionLostMessage: connectionLostMessage(),
        setConnectionState,
        setNotice,
        setStreamingTextByThread,
        showConnectionNotice,
      });
    },
    retryConnection: () => {
      retryConnectionAction({
        client: getClient(),
        setConnectionAttempt,
        setConnectionState,
        setNotice,
        setStreamingTextByThread,
      });
    },
    showDemoThreads: () => {
      showDemoThreadsAction({
        demoThreads: demoThreads(),
        setSelectedThreadId,
        setStreamingTextByThread,
        setThreads,
      });
    },
    switchToDemoThreads: (showConnectionNotice = true) => {
      switchToDemoThreadsAction({
        connectionLostMessage: connectionLostMessage(),
        demoThreads: demoThreads(),
        setConnectionState,
        setNotice,
        setSelectedThreadId,
        setStreamingTextByThread,
        setThreads,
        showConnectionNotice,
      });
    },
  };
}
