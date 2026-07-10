import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadItem } from "@crewon-protocol/v2/ThreadItem";
import type { Turn } from "@crewon-protocol/v2/Turn";

type ThreadUpdater = (thread: Thread) => Thread;
type FileChangeChanges = Extract<ThreadItem, { type: "fileChange" }>["changes"];
type McpToolCall = Extract<ThreadItem, { type: "mcpToolCall" }>;

export function upsertThread(threads: Thread[], nextThread: Thread): Thread[] {
  const existingIndex = threads.findIndex(
    (thread) => thread.id === nextThread.id,
  );

  if (existingIndex === -1) {
    return [nextThread, ...threads];
  }

  const nextThreads = [...threads];
  nextThreads[existingIndex] = nextThread;
  return nextThreads;
}

export function mergeThreadListSummaries(
  currentThreads: Thread[],
  nextThreads: Thread[],
): Thread[] {
  return nextThreads.map((nextThread) => {
    const currentThread = currentThreads.find(
      (thread) => thread.id === nextThread.id,
    );
    if (
      !currentThread ||
      nextThread.turns.length > 0 ||
      currentThread.turns.length === 0
    ) {
      return nextThread;
    }
    return {
      ...nextThread,
      turns: currentThread.turns,
    };
  });
}

export function updateThreadInList(
  threads: Thread[],
  threadId: string,
  updater: ThreadUpdater,
): Thread[] {
  return threads.map((thread) =>
    thread.id === threadId ? updater(thread) : thread,
  );
}

export function updateThreadName(
  threads: Thread[],
  threadId: string,
  threadName: string | null,
): Thread[] {
  return updateThreadInList(threads, threadId, (thread) => ({
    ...thread,
    name: threadName,
  }));
}

export function updateThreadStatus(
  threads: Thread[],
  threadId: string,
  status: Thread["status"],
): Thread[] {
  return updateThreadInList(threads, threadId, (thread) => ({
    ...thread,
    status,
  }));
}

export function updateThreadTurns(
  threads: Thread[],
  threadId: string,
  turns: Turn[],
): Thread[] {
  return updateThreadInList(threads, threadId, (thread) => ({
    ...thread,
    turns,
  }));
}

export function appendTurnWithFallbackPreview(
  threads: Thread[],
  threadId: string,
  turn: Turn,
  fallbackPreview: string,
  updatedAt: number,
): Thread[] {
  return updateThreadInList(threads, threadId, (thread) => ({
    ...thread,
    name: thread.name || fallbackPreview,
    preview: thread.preview || fallbackPreview,
    updatedAt,
    turns: [...thread.turns, turn],
  }));
}

export function selectedThreadIdAfterThreadList(
  currentThreadId: string | null,
  threads: Thread[] | null | undefined,
): string | null {
  if (
    currentThreadId &&
    threads?.some((thread) => thread.id === currentThreadId)
  ) {
    return currentThreadId;
  }
  return threads?.[0]?.id ?? null;
}

export function removeThreadFromList(
  threads: Thread[],
  threadId: string,
): Thread[] {
  return threads.filter((thread) => thread.id !== threadId);
}

export function selectedThreadIdAfterThreadRemoval(
  currentThreadId: string | null,
  removedThreadId: string,
): string | null {
  return currentThreadId === removedThreadId ? null : currentThreadId;
}

export function userMessageText(item: ThreadItem): string {
  if (item.type !== "userMessage") {
    return "";
  }
  return item.content
    .map((content) => (content.type === "text" ? content.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function compactOfficeMessageText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 1600 ? `${trimmed.slice(0, 1600)}\n...` : trimmed;
}

export function appendItemInThread(
  threads: Thread[],
  threadId: string,
  turnId: string,
  item: ThreadItem,
): Thread[] {
  return updateThreadInList(threads, threadId, (thread) =>
    appendItem(thread, turnId, item),
  );
}

export function appendItem(
  thread: Thread,
  turnId: string,
  item: ThreadItem,
): Thread {
  return {
    ...thread,
    turns: thread.turns.map((turn) =>
      turn.id === turnId
        ? {
            ...turn,
            items: upsertItem(turn.items, item),
          }
        : turn,
    ),
  };
}

export function upsertItem(
  items: ThreadItem[],
  item: ThreadItem,
): ThreadItem[] {
  const existingIndex = items.findIndex(
    (existingItem) => existingItem.id === item.id,
  );

  if (existingIndex === -1) {
    return [...items, item];
  }

  const nextItems = [...items];
  nextItems[existingIndex] = item;
  return nextItems;
}

export function updateItem(
  thread: Thread,
  turnId: string,
  itemId: string,
  updater: (item: ThreadItem) => ThreadItem,
): Thread {
  return {
    ...thread,
    turns: thread.turns.map((turn) =>
      turn.id === turnId
        ? {
            ...turn,
            items: turn.items.map((item) =>
              item.id === itemId ? updater(item) : item,
            ),
          }
        : turn,
    ),
  };
}

export function upsertTurn(thread: Thread, nextTurn: Turn): Thread {
  const existingTurnIndex = thread.turns.findIndex(
    (turn) => turn.id === nextTurn.id,
  );

  if (existingTurnIndex === -1) {
    return { ...thread, turns: [...thread.turns, nextTurn] };
  }

  const turns = [...thread.turns];
  turns[existingTurnIndex] = nextTurn;
  return { ...thread, turns };
}

export function upsertTurnInThread(
  threads: Thread[],
  threadId: string,
  turn: Turn,
): Thread[] {
  return updateThreadInList(threads, threadId, (thread) =>
    upsertTurn(thread, turn),
  );
}

export function updateItemInThread(
  threads: Thread[],
  threadId: string,
  turnId: string,
  itemId: string,
  updater: (item: ThreadItem) => ThreadItem,
): Thread[] {
  return updateThreadInList(threads, threadId, (thread) =>
    updateItem(thread, turnId, itemId, updater),
  );
}

export function appendCommandOutputDeltaInThread(
  threads: Thread[],
  threadId: string,
  turnId: string,
  itemId: string,
  delta: string,
): Thread[] {
  return updateItemInThread(threads, threadId, turnId, itemId, (item) =>
    item.type === "commandExecution"
      ? {
          ...item,
          aggregatedOutput: `${item.aggregatedOutput ?? ""}${delta}`,
        }
      : item,
  );
}

export function appendMcpToolCallProgressInThread(
  threads: Thread[],
  threadId: string,
  turnId: string,
  itemId: string,
  message: string,
): Thread[] {
  return updateItemInThread(threads, threadId, turnId, itemId, (item) =>
    item.type === "mcpToolCall" ? appendMcpToolCallProgress(item, message) : item,
  );
}

function appendMcpToolCallProgress(
  item: McpToolCall,
  message: string,
): McpToolCall {
  const trimmed = message.trim();
  if (!trimmed) {
    return item;
  }

  const existingContent = item.result?.content ?? [];
  return {
    ...item,
    result: {
      content: [
        ...existingContent,
        {
          type: "text",
          text: trimmed,
        },
      ],
      structuredContent: item.result?.structuredContent ?? null,
      _meta: item.result?._meta ?? null,
    },
  };
}

export function updateFileChangeItemChangesInThread(
  threads: Thread[],
  threadId: string,
  turnId: string,
  itemId: string,
  changes: FileChangeChanges,
): Thread[] {
  return updateItemInThread(threads, threadId, turnId, itemId, (item) =>
    item.type === "fileChange" ? { ...item, changes } : item,
  );
}

export function appendPlanDeltaInThread(
  threads: Thread[],
  threadId: string,
  turnId: string,
  itemId: string,
  delta: string,
): Thread[] {
  return updateItemInThread(threads, threadId, turnId, itemId, (item) =>
    item.type === "plan" ? { ...item, text: `${item.text}${delta}` } : item,
  );
}

function appendIndexedText(
  values: string[],
  index: number,
  delta: string,
): string[] {
  const next = [...values];
  while (next.length <= index) {
    next.push("");
  }
  next[index] = `${next[index] ?? ""}${delta}`;
  return next;
}

function ensureIndexedText(values: string[], index: number): string[] {
  const next = [...values];
  while (next.length <= index) {
    next.push("");
  }
  next[index] ??= "";
  return next;
}

export function appendReasoningSummaryDeltaInThread(
  threads: Thread[],
  threadId: string,
  turnId: string,
  itemId: string,
  summaryIndex: number,
  delta: string,
): Thread[] {
  return updateItemInThread(threads, threadId, turnId, itemId, (item) =>
    item.type === "reasoning"
      ? {
          ...item,
          summary: appendIndexedText(item.summary, summaryIndex, delta),
        }
      : item,
  );
}

export function appendReasoningContentDeltaInThread(
  threads: Thread[],
  threadId: string,
  turnId: string,
  itemId: string,
  contentIndex: number,
  delta: string,
): Thread[] {
  return updateItemInThread(threads, threadId, turnId, itemId, (item) =>
    item.type === "reasoning"
      ? {
          ...item,
          content: appendIndexedText(item.content, contentIndex, delta),
        }
      : item,
  );
}

export function ensureReasoningSummaryPartInThread(
  threads: Thread[],
  threadId: string,
  turnId: string,
  itemId: string,
  summaryIndex: number,
): Thread[] {
  return updateItemInThread(threads, threadId, turnId, itemId, (item) =>
    item.type === "reasoning"
      ? {
          ...item,
          summary: ensureIndexedText(item.summary, summaryIndex),
        }
      : item,
  );
}

export function threadTitle(thread: Thread, fallback: string): string {
  return thread.name || thread.preview || fallback;
}
