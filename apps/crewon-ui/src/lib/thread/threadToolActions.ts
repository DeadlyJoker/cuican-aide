import type { ReviewStartResponse } from "@crewon/app-server-protocol/v2/ReviewStartResponse";
import type { ReviewTarget } from "@crewon/app-server-protocol/v2/ReviewTarget";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import type { NoticeState } from "../shared/noticeState";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import { demoCapabilityPanel } from "../demo/demoContent";
import type { Locale, ToolId } from "../i18n";
import {
  sideChatCreatedPanel,
  sideChatCreatingPanel,
  sideChatErrorPanel,
} from "../side-chat/sideChatPanel";
import { threadReviewFailureNotice } from "./threadActionPresentation";
import {
  upsertThread,
  upsertTurnInThread,
} from "./threadModel";

type ThreadToolClient = {
  forkThread(threadId: string): Promise<{ thread: Thread }>;
  startReview(
    threadId: string,
    target?: ReviewTarget,
  ): Promise<ReviewStartResponse>;
};

type SetCapabilityPanel = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

type BaseThreadToolActionParams = {
  busyToolId: ToolId | null;
  client: ThreadToolClient | null | undefined;
  createThread: () => Promise<Thread | null>;
  isConnected: boolean;
  isDemo: boolean;
  isDemoPreview: boolean;
  locale: Locale;
  selectedThread: Thread | null;
  setBusyToolId: (toolId: ToolId | null) => void;
  setCapabilityPanel: SetCapabilityPanel;
  setSelectedThreadId: (threadId: string) => void;
  setThreads: (updater: (currentThreads: Thread[]) => Thread[]) => void;
};

export type StartReviewActionParams = BaseThreadToolActionParams & {
  preserveThreadsAfterConnectionLoss: () => void;
  setNotice: (notice: NoticeState) => void;
};

export type StartSideChatActionParams = BaseThreadToolActionParams;

export async function startReviewAction(params: StartReviewActionParams) {
  const {
    busyToolId,
    client,
    createThread,
    isConnected,
    isDemo,
    isDemoPreview,
    locale,
    preserveThreadsAfterConnectionLoss,
    selectedThread,
    setBusyToolId,
    setCapabilityPanel,
    setNotice,
    setSelectedThreadId,
    setThreads,
  } = params;

  if (busyToolId) {
    return;
  }
  if (isDemo) {
    setCapabilityPanel(demoCapabilityPanel("review", locale));
    return;
  }
  if (!isConnected) {
    return;
  }

  setBusyToolId("review");

  try {
    const thread = await selectedOrCreatedThread({
      createThread,
      isDemoPreview,
      selectedThread,
    });
    if (!thread) {
      return;
    }

    const response = await client?.startReview(thread.id);
    if (response) {
      setSelectedThreadId(response.reviewThreadId);
      setThreads((current) =>
        upsertTurnInThread(current, response.reviewThreadId, response.turn),
      );
    }
  } catch (error) {
    preserveThreadsAfterConnectionLoss();
    setNotice(threadReviewFailureNotice(error, locale));
  } finally {
    setBusyToolId(null);
  }
}

export async function startSideChatAction(params: StartSideChatActionParams) {
  const {
    busyToolId,
    client,
    createThread,
    isConnected,
    isDemo,
    isDemoPreview,
    locale,
    selectedThread,
    setBusyToolId,
    setCapabilityPanel,
    setSelectedThreadId,
    setThreads,
  } = params;

  if (isDemo) {
    setCapabilityPanel(demoCapabilityPanel("sidechat", locale));
    return;
  }
  if (busyToolId || !isConnected) {
    return;
  }

  setBusyToolId("sidechat");
  setCapabilityPanel(sideChatCreatingPanel(locale));

  try {
    const thread = await selectedOrCreatedThread({
      createThread,
      isDemoPreview,
      selectedThread,
    });
    if (!thread) {
      return;
    }

    const response = await client?.forkThread(thread.id);
    if (response) {
      setThreads((current) => upsertThread(current, response.thread));
      setSelectedThreadId(response.thread.id);
      setCapabilityPanel(sideChatCreatedPanel(response.thread.id, locale));
    }
  } catch (error) {
    setCapabilityPanel(sideChatErrorPanel(error, locale));
  } finally {
    setBusyToolId(null);
  }
}

async function selectedOrCreatedThread(params: {
  createThread: () => Promise<Thread | null>;
  isDemoPreview: boolean;
  selectedThread: Thread | null;
}): Promise<Thread | null> {
  const { createThread, isDemoPreview, selectedThread } = params;
  if (!isDemoPreview && selectedThread) {
    return selectedThread;
  }
  return createThread();
}
