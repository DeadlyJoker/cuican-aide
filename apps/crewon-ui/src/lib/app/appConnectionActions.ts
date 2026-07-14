import type { Thread } from "@crewon-protocol/v2/Thread";

import { upsertThread } from "../thread/threadModel";
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
  readThread?(threadId: string): Promise<Thread>;
};

type ConnectionStateSetter = (state: ConnectionState) => void;
type NoticeSetter = (notice: NoticeState | null) => void;
type StreamingTextSetter = (streamingTextByThread: Record<string, string>) => void;
type ThreadListSetter = (threads: Thread[]) => void;
type SelectedThreadSetter = (threadId: string | null) => void;

export const APP_SERVER_RECONNECT_DELAY_MS = 5000;

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

export function scheduleReconnectAction(params: {
  clearTimeout: (timeoutId: ReturnType<typeof setTimeout>) => void;
  client: AppServerConnection | null | undefined;
  delayMs?: number;
  setConnectionAttempt: (updater: (attempt: number) => number) => void;
  setConnectionState: ConnectionStateSetter;
  setTimeout: (
    handler: () => void,
    timeout: number,
  ) => ReturnType<typeof setTimeout>;
}): () => void {
  const timeoutId = params.setTimeout(() => {
    params.client?.close();
    params.setConnectionState("connecting");
    params.setConnectionAttempt((attempt) => attempt + 1);
  }, params.delayMs ?? APP_SERVER_RECONNECT_DELAY_MS);

  return () => {
    params.clearTimeout(timeoutId);
  };
}

export function runConnectionBootstrapEffectAction<
  Client extends BootstrapConnectionClient,
>(params: {
  createClient: (onConnectionLost: () => void) => Client;
  currentClient: () => Client | null | undefined;
  isDemoPreview: boolean;
  preserveThreadsAfterConnectionLoss: (showConnectionNotice?: boolean) => void;
  restoreThread?: (client: Client, thread: Thread) => Promise<Thread>;
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
    .then(() => {
      if (!isMounted) {
        return;
      }

      params.setConnectionState("connected");
      params.setNotice(null);
      if (params.isDemoPreview) {
        params.showDemoThreads();
      } else {
        void client
          .listThreads(params.showArchivedThreads)
          .then((serverThreads) => {
            if (!isMounted || params.currentClient() !== client) {
              return;
            }
            const selectedThread = serverThreads[0] ?? null;
            params.setThreads(serverThreads);
            params.setSelectedThreadId(selectedThread?.id ?? null);
            refreshSelectedThreadAfterBootstrap({
              client,
              currentClient: params.currentClient,
              isMounted: () => isMounted,
              restoreThread: params.restoreThread,
              selectedThread,
              setThreads: params.setThreads,
              serverThreads,
            });
          })
          .catch(() => undefined);
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

function refreshSelectedThreadAfterBootstrap<
  Client extends BootstrapConnectionClient,
>(params: {
  client: Client;
  currentClient: () => Client | null | undefined;
  isMounted: () => boolean;
  restoreThread?: (client: Client, thread: Thread) => Promise<Thread>;
  selectedThread: Thread | null;
  setThreads: ThreadListSetter;
  serverThreads: Thread[];
}) {
  if (!params.selectedThread || !params.client.readThread) {
    return;
  }

  void params.client
    .readThread(params.selectedThread.id)
    .then((thread) =>
      params.restoreThread
        ? params.restoreThread(params.client, thread).catch(() => thread)
        : thread,
    )
    .then((thread) => {
      if (!params.isMounted() || params.currentClient() !== params.client) {
        return;
      }
      params.setThreads(upsertThread(params.serverThreads, thread));
    })
    .catch(() => undefined);
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
  setConnectionState: ConnectionStateSetter;
  setNotice: NoticeSetter;
  setStreamingTextByThread: StreamingTextSetter;
  showConnectionNotice?: boolean;
}): void {
  params.setConnectionState("disconnected");
  params.setNotice(
    params.showConnectionNotice ?? true
      ? connectionLostNotice(params.connectionLostMessage)
      : null,
  );
  params.setStreamingTextByThread({});
}
