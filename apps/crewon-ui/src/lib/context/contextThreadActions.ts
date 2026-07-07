import type { Thread } from "@crewon-protocol/v2/Thread";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";

import {
  activeTurnByThreadAfterTurn,
} from "../thread/threadRuntimeState";
import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  contextThreadTitle,
  sendContextFailurePanel,
  sendContextNotice,
  sendContextProgressPanel,
  sendContextSuccessPanel,
} from "../file/fileActionPresentation";
import { contextFileThreadPrompt } from "./contextFilePrompt";
import type { Locale } from "../i18n";
import {
  threadTitle,
  upsertThread,
  upsertTurnInThread,
} from "../thread/threadModel";

export type ContextThreadAction = "sendContext";

type PendingContextFile = {
  path: string;
  text: string;
};

type ContextThreadClient = {
  resumeThread(threadId: string): Promise<Thread>;
  startTurn(threadId: string, text: string): Promise<TurnStartResponse>;
};

type SetCapabilityPanel = (
  updater: (currentPanel: CapabilityPanel | null) => CapabilityPanel | null,
) => void;

export type ContextThreadActionHandlersParams = {
  busyToolId: string | null;
  client: ContextThreadClient | null | undefined;
  createThread: (initialPrompt?: string) => Promise<Thread | null>;
  isConnected: boolean;
  locale: Locale;
  pendingContextFile: PendingContextFile | null;
  selectedThread: Thread | null;
  setActiveTurnByThread: (
    updater: (current: Record<string, string>) => Record<string, string>,
  ) => void;
  setBusyToolId: (toolId: "files" | null) => void;
  setCapabilityPanel: SetCapabilityPanel;
  setNotice: (notice: NoticeState) => void;
  setSelectedThreadId: (threadId: string) => void;
  setThreads: (updater: (currentThreads: Thread[]) => Thread[]) => void;
  threadId: string | null;
};

export function contextThreadActionForActionId(
  actionId: string,
): ContextThreadAction | null {
  return actionId === "send-context-to-thread" ? "sendContext" : null;
}

export function createContextThreadActionHandlers(
  params: ContextThreadActionHandlersParams,
): Record<ContextThreadAction, () => void> {
  return {
    sendContext: () => sendContextToThread(params),
  };
}

function sendContextToThread(params: ContextThreadActionHandlersParams) {
  const {
    busyToolId,
    isConnected,
    pendingContextFile,
  } = params;

  if (!pendingContextFile || busyToolId || !isConnected) {
    return;
  }

  void sendContextToThreadWithBackend(params, pendingContextFile);
}

async function sendContextToThreadWithBackend(
  params: ContextThreadActionHandlersParams,
  contextFile: PendingContextFile,
) {
  const {
    client,
    createThread,
    locale,
    selectedThread,
    setActiveTurnByThread,
    setBusyToolId,
    setCapabilityPanel,
    setNotice,
    setSelectedThreadId,
    setThreads,
  } = params;

  setBusyToolId("files");
  setCapabilityPanel((currentPanel) =>
    sendContextProgressPanel(currentPanel, locale),
  );

  try {
    let thread = params.threadId ? selectedThread : null;
    if (thread?.status.type === "notLoaded") {
      thread = (await client?.resumeThread(thread.id)) ?? thread;
    }
    if (!thread) {
      thread = await createThread(contextThreadTitle(contextFile.path, locale));
    }
    if (!thread) {
      return;
    }

    setThreads((current) => upsertThread(current, thread));
    setSelectedThreadId(thread.id);

    const prompt = contextFileThreadPrompt({
      path: contextFile.path,
      text: contextFile.text,
      locale,
    });

    const response = await client?.startTurn(thread.id, prompt);
    if (response) {
      setThreads((current) =>
        upsertTurnInThread(current, thread.id, response.turn),
      );
      setActiveTurnByThread((current) =>
        activeTurnByThreadAfterTurn(current, thread.id, response.turn),
      );
    }
    setCapabilityPanel((currentPanel) =>
      sendContextSuccessPanel(
        currentPanel,
        threadTitle(thread, thread.id),
        locale,
      ),
    );
    setNotice(sendContextNotice(locale));
  } catch (error) {
    setCapabilityPanel((currentPanel) =>
      sendContextFailurePanel(currentPanel, error, locale),
    );
  } finally {
    setBusyToolId(null);
  }
}
