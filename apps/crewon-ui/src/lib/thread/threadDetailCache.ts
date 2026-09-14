import {
  replaceThreadCatalogPage,
  boundThreadCatalogWorkingSet,
} from "./threadCatalogWorkingSet";
import type { SetStateAction } from "react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import { ThreadDetailSize } from "./threadDetailSize";
import {
  threadListEventSummary,
  type ThreadListSummary,
} from "./threadListEventSummary";

export type ThreadDetailBudget = Readonly<{
  maxThreads: number;
  maxBytes: number;
}>;
export const DEFAULT_THREAD_DETAIL_BUDGET: ThreadDetailBudget = Object.freeze({
  maxThreads: 3,
  maxBytes: 32 * 1024 * 1024,
});
export type ThreadDetailCacheUsage = Readonly<{
  retainedThreads: number;
  protectedThreads: number;
  oversizedThreads: number;
  /** A lower bound when oversizedThreads > 0; estimates saturate per detail. */
  estimatedBytes: number;
  overBudget: boolean;
}>;
export type ThreadCollectionState = Readonly<{
  summaries: readonly Thread[];
  catalogIds: readonly string[] | null;
  details: ReadonlyMap<string, Thread>;
  /** Oldest first; contains only retained detail IDs, never lifetime history. */
  recency: readonly string[];
  selectedThreadId: string | null;
  activeTurnByThread: Record<string, string>;
  usage: ThreadDetailCacheUsage;
}>;
export type ThreadCollectionAction =
  | { type: "catalogPage"; threads: readonly Thread[] }
  | { type: "threads"; update: SetStateAction<Thread[]> }
  | { type: "selection"; update: SetStateAction<string | null> }
  | { type: "activeTurns"; update: SetStateAction<Record<string, string>> };

export function initialThreadCollection(): ThreadCollectionState {
  return {
    summaries: [],
    catalogIds: null,
    details: new Map(),
    recency: [],
    selectedThreadId: null,
    activeTurnByThread: {},
    usage: {
      retainedThreads: 0,
      protectedThreads: 0,
      oversizedThreads: 0,
      estimatedBytes: 0,
      overBudget: false,
    },
  };
}

export function materializeThreads(state: ThreadCollectionState): Thread[] {
  return state.summaries.map(
    (summary) => state.details.get(summary.id) ?? summary,
  );
}

export function createThreadCollectionReducer(
  budget: ThreadDetailBudget = DEFAULT_THREAD_DETAIL_BUDGET,
) {
  if (
    !Number.isSafeInteger(budget.maxThreads) ||
    budget.maxThreads < 1 ||
    !Number.isSafeInteger(budget.maxBytes) ||
    budget.maxBytes < 1
  ) {
    throw new Error("thread_detail_budget_invalid");
  }
  const { maxThreads, maxBytes } = budget;
  const sizes = new ThreadDetailSize(maxBytes);
  const summaries = new WeakMap<Thread, Thread>();

  return (
    state: ThreadCollectionState,
    action: ThreadCollectionAction,
  ): ThreadCollectionState => {
    let catalogIds = state.catalogIds;
    let selectedThreadId = state.selectedThreadId;
    let activeTurnByThread = state.activeTurnByThread;
    let threads = materializeThreads(state);
    switch (action.type) {
      case "catalogPage":
        catalogIds = action.threads.map((thread) => thread.id);
        threads = replaceThreadCatalogPage(
          threads,
          action.threads,
          selectedThreadId,
          activeTurnByThread,
        );
        break;
      case "threads":
        threads = apply(action.update, threads);
        break;
      case "selection":
        selectedThreadId = apply(action.update, selectedThreadId);
        break;
      case "activeTurns":
        activeTurnByThread = apply(action.update, activeTurnByThread);
        break;
    }
    if (catalogIds !== null)
      threads = boundThreadCatalogWorkingSet(
        threads,
        catalogIds,
        selectedThreadId,
        activeTurnByThread,
      );
    const details = new Map<string, Thread>();
    const nextSummaries = threads.map((thread) => {
      if (
        thread.turns.length > 0 ||
        thread.status.type !== "notLoaded" ||
        "controlTaskChangeLedger" in thread
      ) {
        details.set(thread.id, thread);
      }
      let summary = summaries.get(thread);
      if (summary === undefined) {
        summary = detailFreeSummary(thread);
        summaries.set(thread, summary);
        summaries.set(summary, summary);
      }
      return summary;
    });
    let recency = state.recency.filter((id) => details.has(id));
    const touched = [...details.values()]
      .filter((thread) => state.details.get(thread.id) !== thread)
      .map((thread) => thread.id)
      .reverse();
    if (selectedThreadId !== null && details.has(selectedThreadId)) {
      const selectedIndex = touched.indexOf(selectedThreadId);
      if (selectedIndex !== -1) touched.splice(selectedIndex, 1);
      touched.push(selectedThreadId);
    }
    const touchedSet = new Set(touched);
    recency = [
      ...recency.filter((id) => !touchedSet.has(id)),
      ...new Set(touched),
    ];
    const protectedIds = new Set<string>();
    const weights = new Map<string, number>();
    let bytes = 0;
    for (const [id, thread] of details) {
      if (
        id === selectedThreadId ||
        activeTurnByThread[id] !== undefined ||
        thread.status.type === "active" ||
        thread.turns.some((turn) => turn.status === "inProgress") ||
        !recoverableControlDetail(thread)
      ) {
        protectedIds.add(id);
      }
      const weight = sizes.measure(thread);
      weights.set(id, weight);
      bytes += weight;
    }
    for (const id of recency) {
      if (details.size <= maxThreads && bytes <= maxBytes) break;
      if (protectedIds.has(id)) continue;
      details.delete(id);
      bytes -= weights.get(id)!;
    }
    recency = recency.filter((id) => details.has(id));
    return {
      summaries: nextSummaries,
      catalogIds,
      details,
      recency,
      selectedThreadId,
      activeTurnByThread,
      usage: {
        retainedThreads: details.size,
        protectedThreads: protectedIds.size,
        oversizedThreads: [...details.keys()].filter(
          (id) => weights.get(id)! > maxBytes,
        ).length,
        estimatedBytes: bytes,
        overBudget: details.size > maxThreads || bytes > maxBytes,
      },
    };
  };
}

function apply<T>(update: SetStateAction<T>, current: T): T {
  return typeof update === "function"
    ? (update as (current: T) => T)(current)
    : update;
}

function recoverableControlDetail(thread: Thread): boolean {
  return (
    !thread.ephemeral &&
    thread.modelProvider === "crewon-control" &&
    thread.clientVersion === "control-api-v1"
  );
}

/** Deliberate allowlist: a ledger or future body attachment cannot leak into the list. */
function detailFreeSummary(thread: Thread): ThreadListSummary {
  const event = threadListEventSummary(thread);
  const preview =
    thread.preview.length <= 512
      ? thread.preview
      : `${thread.preview.slice(0, 510).replace(/[\uD800-\uDBFF]$/u, "")}…`;
  return {
    id: thread.id,
    sessionId: thread.sessionId,
    forkedFromId: thread.forkedFromId,
    parentThreadId: thread.parentThreadId,
    preview: copySummaryText(preview),
    ephemeral: thread.ephemeral,
    modelProvider: thread.modelProvider,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: { type: "notLoaded" },
    path: thread.path,
    cwd: thread.cwd,
    ...("workspaceId" in thread
      ? {
          workspaceId:
            typeof thread.workspaceId === "string" ? thread.workspaceId : null,
        }
      : {}),
    clientVersion: thread.clientVersion,
    source: thread.source,
    threadSource: thread.threadSource,
    agentNickname: thread.agentNickname,
    agentRole: thread.agentRole,
    gitInfo: thread.gitInfo,
    name: thread.name === null ? null : copySummaryText(thread.name),
    turns: [],
    uiListEventSummary: {
      status:
        event.status.type === "active"
          ? { type: "active", activeFlags: [...event.status.activeFlags] }
          : { type: event.status.type },
      latestTurn:
        event.latestTurn === null
          ? null
          : {
              ...event.latestTurn,
              id: copySummaryText(event.latestTurn.id),
            },
    },
  };
}

function copySummaryText(value: string): string {
  // A short V8 sliced string can retain the original message backing storage.
  // Rebuild code units to own the small string without changing UTF-16 content.
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += 512) {
    const units = new Uint16Array(Math.min(512, value.length - offset));
    for (let index = 0; index < units.length; index++) {
      units[index] = value.charCodeAt(offset + index);
    }
    chunks.push(String.fromCharCode(...units));
  }
  return chunks.join("");
}
