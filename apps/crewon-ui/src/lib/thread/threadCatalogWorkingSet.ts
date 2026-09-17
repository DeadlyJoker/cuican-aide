import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

/** Paged metadata is replaceable. Selected/live details stay independently addressable. */
export function replaceThreadCatalogPage(
  current: readonly Thread[],
  page: readonly Thread[],
  selectedId: string | null,
  activeTurns: Readonly<Record<string, string>>,
): Thread[] {
  const prior = new Map(current.map((thread) => [thread.id, thread]));
  const ids = new Set(page.map((thread) => thread.id));
  const assistant = latestAssistantId(current);
  const merged = page.map((summary) =>
    mergeThreadMetadata(prior.get(summary.id), summary),
  );
  for (const thread of current)
    if (
      !ids.has(thread.id) &&
      (thread.id === assistant ||
        thread.id === selectedId ||
        activeTurns[thread.id] !== undefined ||
        thread.status.type === "active" ||
        thread.turns.some((turn) => turn.status === "inProgress"))
    )
      merged.push(thread);
  return merged;
}

/** Metadata cannot erase a loaded transcript; a canonical detail (including rollback) can. */
export function mergeThreadMetadata(
  current: Thread | undefined,
  incoming: Thread,
): Thread {
  if (
    current === undefined ||
    incoming.status.type !== "notLoaded" ||
    incoming.turns.length > 0 ||
    "controlTaskChangeLedger" in incoming ||
    (current.status.type === "notLoaded" &&
      current.turns.length === 0 &&
      !("controlTaskChangeLedger" in current))
  )
    return incoming;
  return {
    ...current,
    name: incoming.name,
    preview: incoming.preview,
    updatedAt: incoming.updatedAt,
  };
}

/** A few newly-created or just-settled summaries may arrive between page commits and selection. */
export function boundThreadCatalogWorkingSet(
  threads: readonly Thread[],
  pageIds: readonly string[],
  selectedId: string | null,
  activeTurns: Readonly<Record<string, string>>,
): Thread[] {
  const keep = new Set(pageIds);
  const assistant = latestAssistantId(threads);
  let spare = 0;
  return threads.filter(
    (thread) =>
      keep.has(thread.id) ||
      thread.id === selectedId ||
      thread.id === assistant ||
      activeTurns[thread.id] !== undefined ||
      thread.status.type === "active" ||
      thread.turns.some((turn) => turn.status === "inProgress") ||
      spare++ < 3,
  );
}

function latestAssistantId(threads: readonly Thread[]): string | null {
  let latest: Thread | undefined;
  for (const thread of threads)
    if (
      thread.threadSource === "assistant" &&
      (latest === undefined || thread.updatedAt > latest.updatedAt)
    )
      latest = thread;
  return latest?.id ?? null;
}
