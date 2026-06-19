import type { Thread } from "@crewon-protocol/v2/Thread";

import { connectionLostNotice } from "./appNotificationPresentation";
import type { ConnectionState, NoticeState } from "./appRuntimeState";
import type { AccountStatus } from "./appStatusTypes";

type AppServerConnection = {
  close(): void;
};

type LoadedThreadClient = {
  listLoadedThreadIds(): Promise<string[]>;
};

type BootstrapConnectionClient = AppServerConnection & {
  connect(): Promise<unknown>;
  getAccount(): Promise<AccountStatus>;
  listThreads(showArchived: boolean): Promise<Thread[]>;
};

type ConnectionStateSetter = (state: ConnectionState) => void;
type NoticeSetter = (notice: NoticeState | null) => void;
type StreamingTextSetter = (streamingTextByThread: Record<string, string>) => void;
type ThreadListSetter = (threads: Thread[]) => void;
type SelectedThreadSetter = (threadId: string | null) => void;

export function retryConnectionAction(params: {
  client: AppServerConnection | null | undefined;
  setConnectionAttempt: (updater: (attempt: number) => number) => void;
  setConnectionState: ConnectionStateSetter;
  setNotice: NoticeSetter;
  setStreamingTextByThread: StreamingTextSetter;
}): void {
  params.client?.close();
  params.setConnectionState("connecting");
  params.setNotice(null);
  params.setStreamingTextByThread({});
  params.setConnectionAttempt((attempt) => attempt + 1);
}

export function runConnectionBootstrapEffectAction<
  Client extends BootstrapConnectionClient,
>(params: {
  createClient: (onConnectionLost: () => void) => Client;
  currentClient: () => Client | null | undefined;
  isDemoPreview: boolean;
  preserveThreadsAfterConnectionLoss: (showConnectionNotice?: boolean) => void;
  setAccountStatus: (accountStatus: AccountStatus) => void;
  setClient: (client: Client) => void;
  setConnectionState: ConnectionStateSetter;
  setNotice: NoticeSetter;
  setSelectedThreadId: SelectedThreadSetter;
  setThreads: ThreadListSetter;
  showArchivedThreads: boolean;
  showDemoThreads: () => void;
  switchToDemoThreads: (showConnectionNotice?: boolean) => void;
}): () => void {
  let isMounted = true;

  if (params.isDemoPreview) {
    params.switchToDemoThreads(false);
  }

  const client = params.createClient(() => {
    if (!isMounted || params.currentClient() !== client) {
      return;
    }

    params.preserveThreadsAfterConnectionLoss();
  });
  params.setClient(client);

  void client
    .connect()
    .then(() => client.listThreads(params.showArchivedThreads))
    .then((serverThreads) => {
      if (!isMounted) {
        return;
      }

      params.setConnectionState("connected");
      params.setNotice(null);
      if (params.isDemoPreview) {
        params.showDemoThreads();
      } else {
        params.setThreads(serverThreads);
        params.setSelectedThreadId(serverThreads[0]?.id ?? null);
      }

      void client
        .getAccount()
        .then(params.setAccountStatus)
        .catch(() => undefined);
    })
    .catch(() => {
      if (!isMounted) {
        return;
      }

      if (params.isDemoPreview) {
        params.switchToDemoThreads(false);
      } else {
        params.preserveThreadsAfterConnectionLoss(true);
      }
    });

  return () => {
    isMounted = false;
    client.close();
  };
}

export function pollLoadedThreadIdsAction(params: {
  clearInterval: (intervalId: ReturnType<typeof setInterval>) => void;
  client: LoadedThreadClient | null | undefined;
  isConnected: boolean;
  setInterval: (
    handler: () => void,
    timeout: number,
  ) => ReturnType<typeof setInterval>;
  setLoadedThreadIds: (threadIds: string[]) => void;
}): (() => void) | undefined {
  if (!params.isConnected) {
    params.setLoadedThreadIds([]);
    return undefined;
  }

  let cancelled = false;
  const refreshLoadedThreads = () => {
    void (async () => {
      try {
        const threadIds = await params.client?.listLoadedThreadIds();
        if (!cancelled) {
          params.setLoadedThreadIds(threadIds ?? []);
        }
      } catch {
        if (!cancelled) {
          params.setLoadedThreadIds([]);
        }
      }
    })();
  };

  refreshLoadedThreads();
  const intervalId = params.setInterval(refreshLoadedThreads, 10000);

  return () => {
    cancelled = true;
    params.clearInterval(intervalId);
  };
}

export function showDemoThreadsAction(params: {
  demoThreads: Thread[];
  setSelectedThreadId: SelectedThreadSetter;
  setStreamingTextByThread: StreamingTextSetter;
  setThreads: ThreadListSetter;
}): void {
  params.setThreads(params.demoThreads);
  params.setSelectedThreadId(params.demoThreads[0]?.id ?? null);
  params.setStreamingTextByThread({});
}

export function switchToDemoThreadsAction(params: {
  connectionLostMessage: string;
  demoThreads: Thread[];
  setConnectionState: ConnectionStateSetter;
  setNotice: NoticeSetter;
  setSelectedThreadId: SelectedThreadSetter;
  setStreamingTextByThread: StreamingTextSetter;
  setThreads: ThreadListSetter;
  showConnectionNotice?: boolean;
}): void {
  params.setConnectionState("demo");
  params.setNotice(
    params.showConnectionNotice ?? true
      ? connectionLostNotice(params.connectionLostMessage)
      : null,
  );
  showDemoThreadsAction(params);
}

export function preserveThreadsAfterConnectionLossAction(params: {
  connectionLostMessage: string;
  currentThreads: readonly Thread[];
  demoThreads: Thread[];
  setConnectionState: ConnectionStateSetter;
  setNotice: NoticeSetter;
  setSelectedThreadId: SelectedThreadSetter;
  setStreamingTextByThread: StreamingTextSetter;
  setThreads: ThreadListSetter;
  showConnectionNotice?: boolean;
}): void {
  params.setConnectionState("demo");
  params.setNotice(
    params.showConnectionNotice ?? true
      ? connectionLostNotice(params.connectionLostMessage)
      : null,
  );
  params.setStreamingTextByThread({});
  if (params.currentThreads.length === 0) {
    showDemoThreadsAction(params);
  }
}
