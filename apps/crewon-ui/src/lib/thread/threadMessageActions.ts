import type { Thread } from "@crewon-protocol/v2/Thread";
import type { Turn } from "@crewon-protocol/v2/Turn";
import type { ThreadItem } from "@crewon-protocol/v2/ThreadItem";
import type { TurnStartResponse } from "@crewon-protocol/v2/TurnStartResponse";
import type { ReviewStartResponse } from "@crewon-protocol/v2/ReviewStartResponse";
import type { ReviewTarget } from "@crewon-protocol/v2/ReviewTarget";

import type { PendingComposerMention } from "../shared/composerMentions";
import {
  activeTurnByThreadAfterTurn,
  activeTurnByThreadAfterTurnId,
} from "./threadRuntimeState";
import type { NoticeState } from "../shared/noticeState";
import { createDemoTurn, createDraftDemoThread } from "../demo/demoData";
import type { Locale } from "../i18n";
import {
  appendTurnWithFallbackPreview,
  updateThreadInList,
  upsertThread,
  upsertTurnInThread,
} from "./threadModel";
import { removeRecordKey } from "../shared/recordState";
import {
  threadCreateFailureNotice,
  threadGuidanceAppendedNotice,
  threadInterruptFailureNotice,
  threadInterruptRequestedNotice,
  threadSendFailureNotice,
} from "./threadActionPresentation";
import type { ThreadRuntimeSettings } from "./threadRuntimeSettings";
import { promptPreview } from "../shared/text";
import { getAgentPlatformAccessToken } from "../agent-platform/agentPlatformClient";
import {
  AppServerRpcError,
  type AgentPlatformChatResponse,
  type AgentPlatformResourceEvent,
} from "../app-server/appServer";
import type { ComposerImageInput } from "../shared/composerImages";
import { restoredAgentPlatformTurns } from "./agentPlatformThreadHistory";

type ThreadSource = string;
type ActiveTurnByThreadSetter = (
  updater: (current: Record<string, string>) => Record<string, string>,
) => void;
type ThreadListSetter = (updater: (current: Thread[]) => Thread[]) => void;

type ThreadMessageClient = {
  clearThreadGoal?(threadId: string): Promise<unknown>;
  interruptTurn(threadId: string, turnId: string): Promise<unknown>;
  readThread?(threadId: string): Promise<Thread>;
  resumeThread(threadId: string): Promise<Thread>;
  startThread(
    cwd?: string,
    threadSource?: ThreadSource,
    settings?: ThreadRuntimeSettings,
  ): Promise<Thread>;
  startTurn(
    threadId: string,
    text: string,
    mentions?: PendingComposerMention[],
    settings?: ThreadRuntimeSettings,
    images?: ComposerImageInput[],
  ): Promise<TurnStartResponse>;
  startReview?(
    threadId: string,
    target?: ReviewTarget,
  ): Promise<ReviewStartResponse>;
  setThreadGoal?(
    threadId: string,
    objective: string,
    tokenBudget: number | null,
  ): Promise<unknown>;
  steerTurn(
    threadId: string,
    text: string,
    mentions?: PendingComposerMention[],
  ): Promise<{ turnId: string }>;
  updateThreadSettings?(
    threadId: string,
    settings: ThreadRuntimeSettings,
  ): Promise<void>;
  runAgentPlatformChat?(
    accessToken: string,
    threadId: string,
    agentId: string,
    message: string,
    onDelta?: (delta: string) => void,
    onResourceEvent?: (
      event: AgentPlatformResourceEvent,
      index: number,
    ) => void,
  ): Promise<AgentPlatformChatResponse>;
  readAgentPlatformSession?(
    accessToken: string,
    threadId: string,
    agentId: string,
  ): Promise<Array<{ role: string; content: string }>>;
  cancelAgentPlatformRunForThread?(threadId: string): Promise<boolean>;
};

export type CreateDemoThreadActionParams = {
  initialPrompt?: string;
  locale: Locale;
  newDraftPreview: string;
  newDraftThread: string;
  setInspectorOpen: (open: boolean) => void;
  setSelectedThreadId: (threadId: string | null) => void;
  setSidebarOpen: (open: boolean) => void;
  setThreads: ThreadListSetter;
  shouldAutoCloseSidebar: () => boolean;
};

export type CreateThreadActionParams = {
  client: Pick<ThreadMessageClient, "startThread"> | null | undefined;
  createDemoThread: (initialPrompt?: string) => Thread;
  initialPrompt?: string;
  isConnected: boolean;
  locale: Locale;
  preserveThreadsAfterConnectionLoss: () => void;
  resolveBackendCwd: () => Promise<string | undefined>;
  setNotice: (notice: NoticeState | null) => void;
  setSelectedThreadId: (threadId: string | null) => void;
  setSidebarOpen: (open: boolean) => void;
  setThreads: ThreadListSetter;
  shouldAutoCloseSidebar: () => boolean;
  threadSettings?: ThreadRuntimeSettings;
  threadSource?: ThreadSource;
  workspaceCwd?: string | null;
};

export type SendMessageActionParams = {
  activeTurnId: string | null;
  client:
    | Pick<
        ThreadMessageClient,
        | "clearThreadGoal"
        | "readThread"
        | "resumeThread"
        | "startReview"
        | "startTurn"
        | "steerTurn"
        | "setThreadGoal"
        | "updateThreadSettings"
        | "runAgentPlatformChat"
        | "readAgentPlatformSession"
      >
    | null
    | undefined;
  createThread: (initialPrompt?: string) => Promise<Thread | null>;
  demoResponse: string;
  isConnected: boolean;
  isDemoPreview: boolean;
  isSending: boolean;
  locale: Locale;
  pendingComposerMentions: PendingComposerMention[];
  preserveThreadsAfterConnectionLoss: () => void;
  selectedThread: Thread | null;
  selectedThreadId: string | null;
  setActiveTurnByThread: ActiveTurnByThreadSetter;
  setComposerFocusSignal: (updater: (signal: number) => number) => void;
  setComposerValue: (value: string) => void;
  setIsSending: (isSending: boolean) => void;
  setNotice: (notice: NoticeState | null) => void;
  setPendingComposerMentions: (mentions: PendingComposerMention[]) => void;
  setSelectedThreadId: (threadId: string | null) => void;
  setThreads: ThreadListSetter;
  text: string;
  images?: ComposerImageInput[];
  threadSettings?: ThreadRuntimeSettings;
};

export type InterruptActiveTurnActionParams = {
  activeTurnId: string | null;
  client:
    | Pick<
        ThreadMessageClient,
        "interruptTurn" | "readThread" | "cancelAgentPlatformRunForThread"
      >
    | null
    | undefined;
  isConnected: boolean;
  locale: Locale;
  selectedThreadId: string | null;
  setActiveTurnByThread: ActiveTurnByThreadSetter;
  setIsSending: (isSending: boolean) => void;
  setNotice: (notice: NoticeState | null) => void;
  setThreads: ThreadListSetter;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textIncludesMentionToken(text: string, token: string): boolean {
  return new RegExp(`(^|\\s)${escapeRegExp(token)}(?=\\s|$)`).test(text);
}

export function visibleComposerMentionsForText(
  text: string,
  mentions: PendingComposerMention[],
): PendingComposerMention[] {
  return mentions.filter(
    (mention) =>
      !mention.token || textIncludesMentionToken(text, mention.token),
  );
}

function agentPlatformTurn(text: string, turnId: string, nowMs: number): Turn {
  const turn = createDemoTurn({ text, responseText: "", nowMs });
  return {
    ...turn,
    id: turnId,
    status: "inProgress",
    completedAt: null,
    durationMs: null,
  };
}

function agentPlatformResponseText(
  response: AgentPlatformChatResponse,
): string {
  return response.message;
}

function updateAgentPlatformTurn(
  threads: Thread[],
  threadId: string,
  turnId: string,
  update: (turn: Turn) => Turn,
): Thread[] {
  return updateThreadInList(threads, threadId, (thread) => ({
    ...thread,
    turns: thread.turns.map((turn) =>
      turn.id === turnId ? update(turn) : turn,
    ),
  }));
}

function appendAgentPlatformDelta(turn: Turn, delta: string): Turn {
  return {
    ...turn,
    items: turn.items.map((item) =>
      item.type === "agentMessage"
        ? { ...item, text: item.text + delta }
        : item,
    ),
  };
}

function agentPlatformResourceItem(
  event: AgentPlatformResourceEvent,
  turnId: string,
  index: number,
): Extract<ThreadItem, { type: "dynamicToolCall" }> {
  const output = event.error ?? JSON.stringify(event.outputSummary ?? "");
  return {
    type: "dynamicToolCall",
    id: `${turnId}-pim-resource-${index}`,
    namespace: `pim-${event.type}`,
    tool: event.name,
    arguments: (event.inputSummary ?? {}) as never,
    status:
      event.status === "started"
        ? "inProgress"
        : event.status === "failed"
          ? "failed"
          : "completed",
    contentItems: output
      ? [{ type: "inputText", text: output.slice(0, 4_000) }]
      : [],
    success: event.status === "started" ? null : event.status === "succeeded",
    durationMs: null,
  };
}

function appendAgentPlatformResourceEvent(
  turn: Turn,
  event: AgentPlatformResourceEvent,
  index: number,
): Turn {
  const item = agentPlatformResourceItem(event, turn.id, index);
  if (event.status !== "started") {
    let matchingIndex = -1;
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const candidate = turn.items[itemIndex];
      if (
        candidate.type === "dynamicToolCall" &&
        candidate.status === "inProgress" &&
        candidate.namespace === item.namespace &&
        candidate.tool === item.tool
      ) {
        matchingIndex = itemIndex;
        break;
      }
    }
    if (matchingIndex >= 0) {
      const items = [...turn.items];
      items[matchingIndex] = { ...item, id: items[matchingIndex].id };
      return { ...turn, items };
    }
  }
  return { ...turn, items: [...turn.items, item] };
}

export function createDemoThreadAction({
  initialPrompt,
  locale,
  newDraftPreview,
  newDraftThread,
  setInspectorOpen,
  setSelectedThreadId,
  setSidebarOpen,
  setThreads,
  shouldAutoCloseSidebar,
}: CreateDemoThreadActionParams): Thread {
  const demoThread = createDraftDemoThread({
    initialPrompt,
    locale,
    newDraftPreview,
    newDraftThread,
  });
  setThreads((current) => [demoThread, ...current]);
  setSelectedThreadId(demoThread.id);
  setInspectorOpen(false);
  if (shouldAutoCloseSidebar()) {
    setSidebarOpen(false);
  }
  return demoThread;
}

export async function createThreadAction({
  client,
  createDemoThread,
  initialPrompt,
  isConnected,
  locale,
  preserveThreadsAfterConnectionLoss,
  resolveBackendCwd,
  setNotice,
  setSelectedThreadId,
  setSidebarOpen,
  setThreads,
  shouldAutoCloseSidebar,
  threadSettings,
  threadSource = "app_server",
  workspaceCwd,
}: CreateThreadActionParams): Promise<Thread | null> {
  if (!isConnected) {
    return createDemoThread(initialPrompt);
  }

  try {
    const threadCwd =
      workspaceCwd === undefined
        ? await resolveBackendCwd()
        : workspaceCwd?.trim() || undefined;
    const thread = await client?.startThread(
      threadCwd || undefined,
      threadSource,
      threadSettings,
    );
    if (thread) {
      setThreads((current) => upsertThread(current, thread));
      setSelectedThreadId(thread.id);
      if (shouldAutoCloseSidebar()) {
        setSidebarOpen(false);
      }
      return thread;
    }
  } catch (error) {
    preserveThreadsAfterConnectionLoss();
    setNotice(threadCreateFailureNotice(error, locale));
    return null;
  }

  return null;
}

export async function sendMessageAction({
  activeTurnId,
  client,
  createThread,
  demoResponse,
  isConnected,
  isDemoPreview,
  isSending,
  locale,
  pendingComposerMentions,
  preserveThreadsAfterConnectionLoss,
  selectedThread,
  selectedThreadId,
  setActiveTurnByThread,
  setComposerFocusSignal,
  setComposerValue,
  setIsSending,
  setNotice,
  setPendingComposerMentions,
  setSelectedThreadId,
  setThreads,
  text,
  images = [],
  threadSettings,
}: SendMessageActionParams): Promise<void> {
  if (isSending) {
    return;
  }

  const visibleMentions = visibleComposerMentionsForText(
    text,
    pendingComposerMentions,
  );
  setIsSending(true);
  let thread = isDemoPreview ? null : selectedThread;
  let failedThreadId = selectedThreadId;
  let createdThreadForMessage = false;
  let agentPlatformTurnId: string | null = null;

  try {
    if (activeTurnId && selectedThreadId && isConnected) {
      const response = await client?.steerTurn(
        selectedThreadId,
        text,
        visibleMentions,
      );
      setPendingComposerMentions([]);
      if (response?.turnId) {
        setActiveTurnByThread((current) =>
          activeTurnByThreadAfterTurnId(
            current,
            selectedThreadId,
            response.turnId,
          ),
        );
      }
      setNotice(threadGuidanceAppendedNotice(locale));
      return;
    }

    if (!thread) {
      thread = await createThread(text);
      createdThreadForMessage = true;
    }

    if (!thread) {
      return;
    }

    const activeThread = thread;

    if (!isConnected) {
      const now = Math.floor(Date.now() / 1000);
      const turn = createDemoTurn({ text, responseText: demoResponse });
      setThreads((current) =>
        appendTurnWithFallbackPreview(
          current,
          activeThread.id,
          turn,
          promptPreview(text),
          now,
        ),
      );
      return;
    }

    const resumedThread =
      activeThread.status.type === "notLoaded"
        ? await client?.resumeThread(activeThread.id)
        : activeThread;

    if (resumedThread) {
      setThreads((current) => upsertThread(current, resumedThread));
      setSelectedThreadId(resumedThread.id);
    }

    const turnThreadId = (resumedThread ?? activeThread).id;
    failedThreadId = turnThreadId;
    if (threadSettings?.executionIntent === "goal") {
      await client?.setThreadGoal?.(turnThreadId, text, null);
    } else if (threadSettings?.executionIntent === "plan") {
      await client?.clearThreadGoal?.(turnThreadId);
    }
    if (threadSettings && !createdThreadForMessage) {
      await client?.updateThreadSettings?.(turnThreadId, threadSettings);
    }
    if (
      threadSettings?.scene?.sceneId === "code" &&
      threadSettings.scene.mode === "review" &&
      !threadSettings.agentPlatformAgentId
    ) {
      const response = await client?.startReview?.(turnThreadId, {
        type: "custom",
        instructions: text,
      });
      if (!response) {
        throw new Error("代码审查服务不可用");
      }
      setPendingComposerMentions([]);
      setThreads((current) =>
        upsertTurnInThread(current, response.reviewThreadId, response.turn),
      );
      setSelectedThreadId(response.reviewThreadId);
      setActiveTurnByThread((current) =>
        activeTurnByThreadAfterTurn(
          current,
          response.reviewThreadId,
          response.turn,
        ),
      );
      return;
    }
    if (threadSettings?.agentPlatformAgentId) {
      const accessToken = await getAgentPlatformAccessToken();
      if (!accessToken) {
        throw new Error("Agent Platform 登录已失效，请重新登录");
      }
      const currentThread = resumedThread ?? activeThread;
      if (currentThread.turns.length === 0) {
        const history = await client?.readAgentPlatformSession?.(
          accessToken,
          turnThreadId,
          threadSettings.agentPlatformAgentId,
        );
        const restoredTurns = restoredAgentPlatformTurns(history ?? []);
        if (restoredTurns.length > 0) {
          setThreads((current) =>
            updateThreadInList(current, turnThreadId, (thread) => ({
              ...thread,
              turns: restoredTurns,
            })),
          );
        }
      }
      const nowMs = Date.now();
      agentPlatformTurnId = `agent-platform-turn-${nowMs}`;
      const pendingTurn = agentPlatformTurn(text, agentPlatformTurnId, nowMs);
      setPendingComposerMentions([]);
      setThreads((current) =>
        appendTurnWithFallbackPreview(
          current,
          turnThreadId,
          pendingTurn,
          promptPreview(text),
          Math.floor(nowMs / 1000),
        ),
      );
      setActiveTurnByThread((current) => ({
        ...current,
        [turnThreadId]: agentPlatformTurnId!,
      }));
      const response = await client?.runAgentPlatformChat?.(
        accessToken,
        turnThreadId,
        threadSettings.agentPlatformAgentId,
        text,
        (delta) => {
          setThreads((current) =>
            updateAgentPlatformTurn(
              current,
              turnThreadId,
              agentPlatformTurnId!,
              (turn) => appendAgentPlatformDelta(turn, delta),
            ),
          );
        },
        (event, index) => {
          setThreads((current) =>
            updateAgentPlatformTurn(
              current,
              turnThreadId,
              agentPlatformTurnId!,
              (turn) => appendAgentPlatformResourceEvent(turn, event, index),
            ),
          );
        },
      );
      if (!response) {
        throw new Error("Agent Platform app-server BFF 不可用");
      }
      setThreads((current) =>
        updateAgentPlatformTurn(
          current,
          turnThreadId,
          agentPlatformTurnId!,
          (turn) => ({
            ...turn,
            status: "completed",
            completedAt: Math.floor(Date.now() / 1000),
            durationMs: response.durationMs,
            items: turn.items.map((item) =>
              item.type === "agentMessage"
                ? { ...item, text: agentPlatformResponseText(response) }
                : item,
            ),
          }),
        ),
      );
      setActiveTurnByThread((current) =>
        removeRecordKey(current, turnThreadId),
      );
      return;
    }
    const response = await client?.startTurn(
      turnThreadId,
      text,
      visibleMentions,
      threadSettings,
      images,
    );
    if (response) {
      setPendingComposerMentions([]);
      setThreads((current) =>
        upsertTurnInThread(current, turnThreadId, response.turn),
      );
      setActiveTurnByThread((current) =>
        activeTurnByThreadAfterTurn(current, turnThreadId, response.turn),
      );
      void refreshThreadAfterTurnStart({
        client,
        setActiveTurnByThread,
        setThreads,
        threadId: turnThreadId,
        turnId: response.turn.id,
      });
    }
  } catch (error) {
    setPendingComposerMentions([]);
    if (isConnected && !(error instanceof AppServerRpcError)) {
      preserveThreadsAfterConnectionLoss();
    }
    setComposerValue(text);
    setComposerFocusSignal((signal) => signal + 1);
    const targetThreadId = failedThreadId;
    if (agentPlatformTurnId && targetThreadId) {
      const errorMessage =
        error instanceof Error ? error.message : "Agent Platform 请求失败";
      setThreads((current) =>
        updateAgentPlatformTurn(
          current,
          targetThreadId,
          agentPlatformTurnId!,
          (turn) => ({
            ...turn,
            status: "failed",
            completedAt: Math.floor(Date.now() / 1000),
            error: {
              message: errorMessage,
              codexErrorInfo: null,
              additionalDetails: null,
            },
          }),
        ),
      );
      setActiveTurnByThread((current) =>
        removeRecordKey(current, targetThreadId),
      );
    } else if (!activeTurnId && targetThreadId) {
      const now = Math.floor(Date.now() / 1000);
      const errorMessage =
        error instanceof Error
          ? error.message
          : locale === "zh"
            ? "发送到模型失败"
            : "Unable to reach the model";
      const failedTurn: Turn = {
        id: `local-failed-${now}`,
        items: [
          {
            id: `local-failed-user-${now}`,
            type: "userMessage",
            clientId: null,
            content: [{ type: "text", text, text_elements: [] }],
          },
        ],
        itemsView: "full",
        status: "failed",
        error: {
          message: errorMessage,
          codexErrorInfo: null,
          additionalDetails: null,
        },
        startedAt: now,
        completedAt: now,
        durationMs: null,
      };
      setThreads((current) =>
        appendTurnWithFallbackPreview(
          current,
          targetThreadId,
          failedTurn,
          promptPreview(text),
          now,
        ),
      );
    }
    setNotice(threadSendFailureNotice(error, locale));
  } finally {
    setIsSending(false);
  }
}

async function refreshThreadAfterTurnStart({
  client,
  setActiveTurnByThread,
  setThreads,
  threadId,
  turnId,
}: {
  client: Pick<ThreadMessageClient, "readThread"> | null | undefined;
  setActiveTurnByThread: ActiveTurnByThreadSetter;
  setThreads: ThreadListSetter;
  threadId: string;
  turnId: string;
}): Promise<void> {
  if (!client?.readThread) {
    return;
  }

  const delaysMs = [250, 500, 1000, 1500, 2500, 4000];
  for (const delayMs of delaysMs) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const thread = await client.readThread(threadId).catch(() => null);
    if (!thread) {
      continue;
    }

    setThreads((current) => upsertThread(current, thread));
    const turn = thread.turns.find((candidate) => candidate.id === turnId);
    if (turn && turn.status !== "inProgress") {
      setActiveTurnByThread((current) => removeRecordKey(current, threadId));
      return;
    }
  }
}

export async function interruptActiveTurnAction({
  activeTurnId,
  client,
  isConnected,
  locale,
  selectedThreadId,
  setActiveTurnByThread,
  setIsSending,
  setNotice,
  setThreads,
}: InterruptActiveTurnActionParams): Promise<void> {
  if (!selectedThreadId || !activeTurnId || !isConnected) {
    return;
  }

  setIsSending(true);
  try {
    const cancelledAgentRun =
      await client?.cancelAgentPlatformRunForThread?.(selectedThreadId);
    if (cancelledAgentRun) {
      setActiveTurnByThread((current) =>
        removeRecordKey(current, selectedThreadId),
      );
      setThreads((current) =>
        updateThreadInList(current, selectedThreadId, (thread) => ({
          ...thread,
          turns: thread.turns.map((turn) =>
            turn.id === activeTurnId && turn.status === "inProgress"
              ? { ...turn, status: "interrupted" }
              : turn,
          ),
        })),
      );
      setNotice(threadInterruptRequestedNotice(locale));
      return;
    }
    await client?.interruptTurn(selectedThreadId, activeTurnId);
    setActiveTurnByThread((current) =>
      removeRecordKey(current, selectedThreadId),
    );
    setThreads((current) =>
      updateThreadInList(current, selectedThreadId, (thread) => ({
        ...thread,
        turns: thread.turns.map((turn) =>
          turn.id === activeTurnId && turn.status === "inProgress"
            ? { ...turn, status: "interrupted" }
            : turn,
        ),
      })),
    );
    const refreshedThread = await client
      ?.readThread?.(selectedThreadId)
      .catch(() => null);
    const refreshedTurn = refreshedThread?.turns.find(
      (turn) => turn.id === activeTurnId,
    );
    if (refreshedThread && refreshedTurn?.status !== "inProgress") {
      setThreads((current) => upsertThread(current, refreshedThread));
    }
    setNotice(threadInterruptRequestedNotice(locale));
  } catch (error) {
    setNotice(threadInterruptFailureNotice(error, locale));
  } finally {
    setIsSending(false);
  }
}
