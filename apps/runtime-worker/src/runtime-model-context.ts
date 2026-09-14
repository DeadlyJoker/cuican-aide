import {
  RunStoreError,
  type DomainStore,
  type ModelHistoryContextStore,
} from "@crewon/application";
import {
  ContextHistoryError,
  projectModelHistory,
  projectModelHistoryWindow,
  type ModelContextProjection,
} from "@crewon/context";
import type { ModelHistoryItem, RunState } from "@crewon/domain";

const PAGE_SIZE = 100;
const MAX_ITEMS = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;

export async function loadRuntimeModelContext(
  store: DomainStore,
  run: RunState,
  options: Readonly<{
    allowAssistantBoundary?: boolean;
    onProgress: () => Promise<void>;
  }>,
): Promise<ModelContextProjection> {
  if (store.modelHistoryContext === undefined) {
    return loadLegacyContext(store, run, options);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await loadIndexedContext(store.modelHistoryContext, run, options);
    } catch (error) {
      if (
        !(error instanceof RunStoreError) ||
        error.code !== "model_history_context_changed" ||
        attempt === 2
      )
        throw error;
    }
  }
  throw new RunStoreError("model_history_context_changed");
}

async function loadIndexedContext(
  store: ModelHistoryContextStore,
  run: RunState,
  options: Readonly<{
    allowAssistantBoundary?: boolean;
    onProgress: () => Promise<void>;
  }>,
): Promise<ModelContextProjection> {
  const locator = { tenantId: run.tenantId, threadId: run.threadId };
  await options.onProgress();
  let progress = await store.prepare(locator);
  while (progress.context === null) {
    await options.onProgress();
    const next = await store.prepare(locator);
    if (next.processedThroughSequence <= progress.processedThroughSequence) {
      throw new RunStoreError("model_history_context_changed");
    }
    progress = next;
  }
  const state = progress.context;
  validateBoundary(state.lastItem, run, options.allowAssistantBoundary);
  const items: Exclude<
    ModelHistoryItem,
    { type: "compaction" | "rollback" }
  >[] = [];
  let cursor = state.lastCompaction?.replacesThroughSequence ?? 0;
  let bytes = 0;
  while (true) {
    await options.onProgress();
    const page = await store.listItems(
      locator,
      state.checkpoint,
      cursor,
      Math.min(PAGE_SIZE, MAX_ITEMS - items.length + 1),
    );
    for (const item of page) {
      bytes += Buffer.byteLength(JSON.stringify(item), "utf8");
      if (items.length >= MAX_ITEMS || bytes > MAX_BYTES)
        throw new ContextHistoryError("context_history_limit_exceeded");
      if (
        item.sequence <= cursor ||
        item.tenantId !== run.tenantId ||
        item.threadId !== run.threadId
      ) {
        throw new ContextHistoryError("context_history_sequence_gap");
      }
      items.push(item);
      cursor = item.sequence;
    }
    if (page.length < PAGE_SIZE) break;
  }
  return projectModelHistoryWindow(
    {
      items,
      lastCompaction: state.lastCompaction,
      latestRollback: state.latestRollback,
      throughHistorySequence: state.checkpoint.throughHistorySequence,
    },
    { maxItems: MAX_ITEMS, maxBytes: MAX_BYTES },
  );
}

async function loadLegacyContext(
  store: DomainStore,
  run: RunState,
  options: Readonly<{
    allowAssistantBoundary?: boolean;
    onProgress: () => Promise<void>;
  }>,
): Promise<ModelContextProjection> {
  const locator = { tenantId: run.tenantId, threadId: run.threadId };
  const head = await store.loadModelHistoryHead(locator);
  if (head === null) throw new ContextHistoryError("model_history_not_found");
  const items: ModelHistoryItem[] = [];
  let cursor = 0;
  let bytes = 0;
  while (items.length < MAX_ITEMS) {
    await options.onProgress();
    const page = await store.listModelHistoryItems(
      locator,
      cursor,
      Math.min(PAGE_SIZE, MAX_ITEMS - items.length),
    );
    for (const item of page) {
      bytes += Buffer.byteLength(JSON.stringify(item), "utf8");
      if (bytes > MAX_BYTES)
        throw new ContextHistoryError("context_history_limit_exceeded");
      items.push(item);
      cursor = item.sequence;
    }
    if (page.length < PAGE_SIZE) break;
  }
  if (cursor !== head.lastSequence || items.length !== head.lastSequence) {
    throw new ContextHistoryError("context_history_limit_exceeded");
  }
  validateBoundary(items.at(-1) ?? null, run, options.allowAssistantBoundary);
  return projectModelHistory(items, {
    maxItems: MAX_ITEMS,
    maxBytes: MAX_BYTES,
  });
}

function validateBoundary(
  last: ModelHistoryItem | null,
  run: RunState,
  allowAssistantBoundary: boolean | undefined,
): void {
  if (
    last === null ||
    !(
      (last.type === "message" &&
        (last.role === "user" || allowAssistantBoundary === true)) ||
      last.runId === run.runId
    )
  ) {
    throw new ContextHistoryError("context_last_turn_boundary_invalid");
  }
}
