import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadItem } from "@crewon-protocol/v2/ThreadItem";
import type { Turn } from "@crewon-protocol/v2/Turn";

export type EmptyThreadSelectionBehavior = "preserve" | "selectFirst";

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

function isPreservableActionItem(item: ThreadItem): boolean {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "subAgentActivity":
    case "webSearch":
    case "imageView":
    case "imageGeneration":
      return true;
    default:
      return false;
  }
}

/** Keep live tool cards if a history refresh omits them (lossy API turns). */
export function mergeTurnsPreservingActionItems(
  currentTurns: Turn[],
  nextTurns: Turn[],
): Turn[] {
  return nextTurns.map((nextTurn) => {
    const currentTurn = currentTurns.find((turn) => turn.id === nextTurn.id);
    if (!currentTurn) {
      return nextTurn;
    }

    const nextIds = new Set(nextTurn.items.map((item) => item.id));
    const missingActions = currentTurn.items.filter(
      (item) => isPreservableActionItem(item) && !nextIds.has(item.id),
    );
    if (missingActions.length === 0) {
      return nextTurn;
    }

    const mergedItems = [...nextTurn.items];
    for (const action of missingActions) {
      const anchorIndex = currentTurn.items.findIndex(
        (item) => item.id === action.id,
      );
      let insertAt = mergedItems.length;
      for (let index = anchorIndex - 1; index >= 0; index -= 1) {
        const priorId = currentTurn.items[index]?.id;
        const priorInMerged = mergedItems.findIndex(
          (item) => item.id === priorId,
        );
        if (priorInMerged >= 0) {
          insertAt = priorInMerged + 1;
          break;
        }
      }
      mergedItems.splice(insertAt, 0, action);
    }

    return { ...nextTurn, items: mergedItems };
  });
}

export function updateThreadTurns(
  threads: Thread[],
  threadId: string,
  turns: Turn[],
): Thread[] {
  return updateThreadInList(threads, threadId, (thread) => ({
    ...thread,
    turns: mergeTurnsPreservingActionItems(thread.turns, turns),
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

/**
 * Merge a turn update without discarding live tool/reasoning items.
 *
 * `turn/completed` intentionally ships `items: []` + `itemsView: notLoaded`.
 * Blindly replacing the turn would wipe streamed commandExecution/MCP cards
 * before an async history refresh can restore them.
 */
export function upsertTurn(thread: Thread, nextTurn: Turn): Thread {
  const existingTurnIndex = thread.turns.findIndex(
    (turn) => turn.id === nextTurn.id,
  );

  if (existingTurnIndex === -1) {
    return { ...thread, turns: [...thread.turns, nextTurn] };
  }

  const existingTurn = thread.turns[existingTurnIndex]!;
  const turns = [...thread.turns];
  turns[existingTurnIndex] = mergeTurnUpsert(existingTurn, nextTurn);
  return { ...thread, turns };
}

function mergeTurnUpsert(existingTurn: Turn, nextTurn: Turn): Turn {
  const nextItemsMissing =
    nextTurn.itemsView === "notLoaded" ||
    (nextTurn.items.length === 0 && existingTurn.items.length > 0);

  if (nextItemsMissing) {
    return {
      ...nextTurn,
      items: existingTurn.items,
      itemsView:
        existingTurn.items.length > 0 ? existingTurn.itemsView : nextTurn.itemsView,
    };
  }

  return mergeTurnsPreservingActionItems([existingTurn], [nextTurn])[0]!;
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
