import {
  MAX_THREAD_TASK_CHANGE_EVENTS,
  MAX_THREAD_TASK_CHANGE_RUN_IDS_BYTES,
  MAX_THREAD_TASK_CHANGE_RUNS,
  MAX_WORKSPACE_CHANGE_PATHS,
  MAX_WORKSPACE_CHANGE_PATHS_BYTES,
  parseThreadTaskChangeLedgerResponse,
  parseWorkspaceChangeSummary,
  type ThreadTaskChangeLedgerResponse,
  type WorkspaceChangeSummary,
} from "@crewon/contracts";
import {
  ModelHistoryError,
  RunLifecycleError,
  projectEffectiveModelHistory,
  reduceRunLifecycleEvent,
  type ModelHistoryHead,
  type ModelHistoryItem,
  type RunLifecycleEvent,
  type RunState,
  type ThreadState,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ModelHistoryStore } from "./model-history-store-port.ts";
import type { RunStore } from "./run-store-port.ts";
import type { ThreadApplicationService } from "./thread-application-service.ts";

const PAGE_SIZE = 100;
const MAX_HISTORY_ITEMS = 100_000;
const MAX_HISTORY_BYTES = 64 * 1_024 * 1_024;
const MAX_EVENTS_PER_RUN = 10_000;
const MAX_MUTATIONS_PER_RUN = 256;
const MAX_EVENT_BYTES = 64 * 1_024 * 1_024;
const NATIVE_WORKSPACE_MUTATION_TOOL = "workspace_run_command";

type ThreadTaskChangeStore = ModelHistoryStore &
  Pick<RunStore, "loadRunInSpace" | "listRunEvents">;

type ThreadReader = Pick<ThreadApplicationService, "getThread">;

type LedgerProjection = Readonly<{
  summary: WorkspaceChangeSummary;
  eventCount: number;
  includedRunIds: string[];
}>;

type RunLedgerProjection = Readonly<{
  summaries: readonly WorkspaceChangeSummary[];
  eventCount: number;
}>;

type ScanBudget = {
  events: number;
  bytes: number;
};

type NativeMutationRequest = Readonly<{
  name: typeof NATIVE_WORKSPACE_MUTATION_TOOL;
  segmentId: string;
  segmentSequence: number;
}>;

/**
 * Authorized, bounded read model for exact native Workspace mutations in one
 * Thread. It never derives changes from transcript previews or branch totals.
 */
export class ThreadTaskChangeQueryService {
  readonly #store: ThreadTaskChangeStore;
  readonly #threads: ThreadReader;

  constructor(dependencies: {
    store: ThreadTaskChangeStore;
    threads: ThreadReader;
  }) {
    this.#store = dependencies.store;
    this.#threads = dependencies.threads;
  }

  async getThreadTaskChanges(
    actor: ActorContext,
    threadId: string,
  ): Promise<ThreadTaskChangeLedgerResponse> {
    const initialThread = await this.#threads.getThread(actor, threadId);
    const initialHead = await this.#loadHistoryHead(actor, threadId);
    let projection: LedgerProjection | null = null;

    if (initialHead !== null) {
      const history = await this.#loadHistory(
        actor,
        threadId,
        initialHead.lastSequence,
      );
      if (history !== null) {
        projection = await this.#projectLedger(actor, initialThread, history);
      }
    }

    // Bind the response to stable Thread and Model History heads. A rollback or
    // append racing this read invalidates the whole projection, never part of it.
    const finalThread = await this.#threads.getThread(actor, threadId);
    const finalHead = await this.#loadHistoryHead(actor, threadId);
    if (
      projection === null ||
      finalHead === null ||
      initialThread.revision !== finalThread.revision ||
      initialHead?.lastSequence !== finalHead.lastSequence
    ) {
      return incompleteResponse(finalThread, finalHead?.lastSequence ?? 0);
    }

    try {
      return parseThreadTaskChangeLedgerResponse({
        schemaVersion: "crewon.thread-task-change-ledger.v0",
        threadId: finalThread.threadId,
        threadRevision: finalThread.revision,
        historySequence: finalHead.lastSequence,
        complete: true,
        summary: projection.summary,
        eventCount: projection.eventCount,
        includedRunIds: projection.includedRunIds,
      });
    } catch {
      return incompleteResponse(finalThread, finalHead.lastSequence);
    }
  }

  async #projectLedger(
    actor: ActorContext,
    thread: ThreadState,
    history: readonly ModelHistoryItem[],
  ): Promise<LedgerProjection | null> {
    let effective;
    try {
      effective = projectEffectiveModelHistory(history);
    } catch (error) {
      if (error instanceof ModelHistoryError) return null;
      throw error;
    }

    const effectiveRunIds: string[] = [];
    const seen = new Set<string>();
    let runIdBytes = 0;
    const inheritedHistoryThrough = thread.forkedThroughHistorySequence ?? 0;
    for (const item of effective.items) {
      // A fork rebases its source history into the target Thread while keeping
      // source Run ids. Those Runs remain owned by the source Thread and are
      // context, not mutations performed by this task.
      if (item.sequence <= inheritedHistoryThrough) continue;
      if (item.runId === null || seen.has(item.runId)) continue;
      seen.add(item.runId);
      effectiveRunIds.push(item.runId);
      runIdBytes += encodedBytes(item.runId);
      if (
        effectiveRunIds.length > MAX_THREAD_TASK_CHANGE_RUNS ||
        runIdBytes > MAX_THREAD_TASK_CHANGE_RUN_IDS_BYTES
      ) {
        return null;
      }
    }

    const includedRunIds: string[] = [];
    const observedActiveTurnRuns: RunState[] = [];
    const summaries: WorkspaceChangeSummary[] = [];
    const budget: ScanBudget = { events: 0, bytes: 0 };
    let eventCount = 0;
    for (const runId of effectiveRunIds) {
      const run = await this.#loadRun(actor, runId);
      // Forked history may refer to source-Thread Runs. The current Thread's
      // authorization does not grant access to those ledgers.
      if (
        run === null ||
        run.tenantId !== actor.tenantId ||
        run.spaceId !== actor.spaceId ||
        run.threadId !== thread.threadId
      ) {
        return null;
      }
      if ((run.purpose ?? "turn") !== "turn") {
        continue;
      }
      if (
        run.status !== "completed" &&
        run.status !== "failed" &&
        run.status !== "canceled"
      ) {
        observedActiveTurnRuns.push(run);
        continue;
      }
      const runProjection = await this.#loadRunLedger(actor, run, budget);
      if (runProjection === null) return null;
      includedRunIds.push(run.runId);
      summaries.push(...runProjection.summaries);
      eventCount += runProjection.eventCount;
      if (
        !Number.isSafeInteger(eventCount) ||
        eventCount > MAX_THREAD_TASK_CHANGE_EVENTS
      ) {
        return null;
      }
    }

    // Run terminalization can be durable without advancing the Thread or
    // Model-History head. Recheck every effective active Turn so a concurrent
    // active→terminal transition cannot be omitted from an "exact" snapshot.
    for (const observed of observedActiveTurnRuns) {
      const current = await this.#loadRun(actor, observed.runId);
      if (
        current === null ||
        current.tenantId !== observed.tenantId ||
        current.spaceId !== observed.spaceId ||
        current.threadId !== observed.threadId ||
        current.revision !== observed.revision ||
        current.lastSequence !== observed.lastSequence ||
        current.status !== observed.status ||
        current.terminalAt !== observed.terminalAt
      ) {
        return null;
      }
    }

    const summary = aggregateSummaries(summaries);
    if (summary === null) return null;
    return { summary, eventCount, includedRunIds };
  }

  async #loadRunLedger(
    actor: ActorContext,
    run: RunState,
    budget: ScanBudget,
  ): Promise<RunLedgerProjection | null> {
    if (run.lastSequence > MAX_EVENTS_PER_RUN) return null;
    let cursor = 0;
    let reduced: RunState | null = null;
    const pending = new Map<string, NativeMutationRequest>();
    const completed = new Set<string>();
    const summaries: WorkspaceChangeSummary[] = [];
    let matchedEvents = 0;
    let mutationCount = 0;

    while (cursor < run.lastSequence) {
      const page = await this.#listRunEvents(
        actor,
        run.runId,
        cursor,
        Math.min(PAGE_SIZE, run.lastSequence - cursor),
      );
      if (
        page.length === 0 ||
        page.length > Math.min(PAGE_SIZE, run.lastSequence - cursor)
      ) {
        return null;
      }
      for (const event of page) {
        if (
          event.identity.runId !== run.runId ||
          event.sequence !== cursor + 1 ||
          event.sequence > run.lastSequence
        ) {
          return null;
        }
        budget.events += 1;
        budget.bytes += encodedJsonBytes(event);
        if (
          budget.events > MAX_THREAD_TASK_CHANGE_EVENTS ||
          budget.bytes > MAX_EVENT_BYTES
        ) {
          return null;
        }
        try {
          reduced = reduceRunLifecycleEvent(reduced, event);
        } catch (error) {
          if (error instanceof RunLifecycleError) return null;
          throw error;
        }
        if (event.type === "tool.requested") {
          if (
            event.data.kind === "function" &&
            event.data.name === NATIVE_WORKSPACE_MUTATION_TOOL
          ) {
            if (
              pending.has(event.data.callId) ||
              completed.has(event.data.callId)
            ) {
              return null;
            }
            pending.set(event.data.callId, {
              name: NATIVE_WORKSPACE_MUTATION_TOOL,
              segmentId: event.data.segmentId,
              segmentSequence: event.data.segmentSequence,
            });
            mutationCount += 1;
            if (mutationCount > MAX_MUTATIONS_PER_RUN) return null;
            matchedEvents += 1;
          }
        } else if (event.type === "tool.completed") {
          const request = pending.get(event.data.callId);
          if (
            event.data.kind === "function" &&
            event.data.name === NATIVE_WORKSPACE_MUTATION_TOOL
          ) {
            if (
              request === undefined ||
              request.name !== NATIVE_WORKSPACE_MUTATION_TOOL ||
              request.segmentId !== event.data.segmentId ||
              event.data.segmentSequence <= request.segmentSequence ||
              completed.has(event.data.callId) ||
              event.data.workspaceChanges === undefined
            ) {
              return null;
            }
            let summary: WorkspaceChangeSummary;
            try {
              summary = parseWorkspaceChangeSummary(
                event.data.workspaceChanges,
              );
            } catch {
              return null;
            }
            if (!summary.statsComplete) return null;
            pending.delete(event.data.callId);
            completed.add(event.data.callId);
            summaries.push(summary);
            matchedEvents += 1;
          } else if (request?.name === NATIVE_WORKSPACE_MUTATION_TOOL) {
            return null;
          }
        }
        cursor = event.sequence;
      }
    }
    if (
      cursor !== run.lastSequence ||
      reduced === null ||
      pending.size !== 0 ||
      !sameRunHead(reduced, run)
    ) {
      return null;
    }
    return { summaries, eventCount: matchedEvents };
  }

  async #loadHistory(
    actor: ActorContext,
    threadId: string,
    lastSequence: number,
  ): Promise<readonly ModelHistoryItem[] | null> {
    if (lastSequence > MAX_HISTORY_ITEMS) return null;
    const items: ModelHistoryItem[] = [];
    let cursor = 0;
    let bytes = 0;
    while (cursor < lastSequence) {
      const page = await this.#listHistoryItems(
        actor,
        threadId,
        cursor,
        Math.min(PAGE_SIZE, lastSequence - cursor),
      );
      if (
        page.length === 0 ||
        page.length > Math.min(PAGE_SIZE, lastSequence - cursor)
      ) {
        return null;
      }
      for (const item of page) {
        if (
          item.tenantId !== actor.tenantId ||
          item.threadId !== threadId ||
          item.sequence !== cursor + 1 ||
          item.sequence > lastSequence
        ) {
          return null;
        }
        bytes += encodedJsonBytes(item);
        if (bytes > MAX_HISTORY_BYTES) return null;
        items.push(item);
        cursor = item.sequence;
      }
    }
    return cursor === lastSequence && items.length === lastSequence
      ? items
      : null;
  }

  async #loadHistoryHead(
    actor: ActorContext,
    threadId: string,
  ): Promise<ModelHistoryHead | null> {
    try {
      const head = await this.#store.loadModelHistoryHead({
        tenantId: actor.tenantId,
        threadId,
      });
      if (
        head === null ||
        head.tenantId !== actor.tenantId ||
        head.threadId !== threadId ||
        !Number.isSafeInteger(head.lastSequence) ||
        head.lastSequence < 0
      ) {
        return null;
      }
      return head;
    } catch (error) {
      throw ledgerUnavailable(error);
    }
  }

  async #listHistoryItems(
    actor: ActorContext,
    threadId: string,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ModelHistoryItem[]> {
    try {
      return await this.#store.listModelHistoryItems(
        { tenantId: actor.tenantId, threadId },
        afterSequence,
        limit,
      );
    } catch (error) {
      throw ledgerUnavailable(error);
    }
  }

  async #loadRun(actor: ActorContext, runId: string): Promise<RunState | null> {
    try {
      return await this.#store.loadRunInSpace({
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        runId,
      });
    } catch (error) {
      throw ledgerUnavailable(error);
    }
  }

  async #listRunEvents(
    actor: ActorContext,
    runId: string,
    afterSequence: number,
    limit: number,
  ): Promise<readonly RunLifecycleEvent[]> {
    try {
      return await this.#store.listRunEvents(
        { tenantId: actor.tenantId, runId },
        afterSequence,
        limit,
      );
    } catch (error) {
      throw ledgerUnavailable(error);
    }
  }
}

function aggregateSummaries(
  summaries: readonly WorkspaceChangeSummary[],
): WorkspaceChangeSummary | null {
  const paths = new Set<string>();
  let pathBytes = 0;
  let additions = 0;
  let deletions = 0;
  for (const summary of summaries) {
    additions += summary.additions;
    deletions += summary.deletions;
    if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions)) {
      return null;
    }
    for (const path of summary.paths) {
      if (paths.has(path)) continue;
      paths.add(path);
      pathBytes += encodedBytes(path);
      if (
        paths.size > MAX_WORKSPACE_CHANGE_PATHS ||
        pathBytes > MAX_WORKSPACE_CHANGE_PATHS_BYTES
      ) {
        return null;
      }
    }
  }
  try {
    return parseWorkspaceChangeSummary({
      schemaVersion: "crewon.workspace-change-summary.v0",
      paths: [...paths].sort(),
      additions,
      deletions,
      statsComplete: true,
    });
  } catch {
    return null;
  }
}

function sameRunHead(projected: RunState, stored: RunState): boolean {
  return (
    projected.runId === stored.runId &&
    projected.threadId === stored.threadId &&
    projected.tenantId === stored.tenantId &&
    projected.spaceId === stored.spaceId &&
    (projected.purpose ?? "turn") === (stored.purpose ?? "turn") &&
    projected.status === stored.status &&
    projected.revision === stored.revision &&
    projected.lastSequence === stored.lastSequence
  );
}

function incompleteResponse(
  thread: ThreadState,
  historySequence: number,
): ThreadTaskChangeLedgerResponse {
  return {
    schemaVersion: "crewon.thread-task-change-ledger.v0",
    threadId: thread.threadId,
    threadRevision: thread.revision,
    historySequence,
    complete: false,
    summary: {
      schemaVersion: "crewon.workspace-change-summary.v0",
      paths: [],
      additions: 0,
      deletions: 0,
      statsComplete: false,
    },
    eventCount: 0,
    includedRunIds: [],
  };
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function encodedJsonBytes(value: unknown): number {
  try {
    return encodedBytes(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function ledgerUnavailable(error: unknown): ApplicationError {
  return new ApplicationError(
    "internal",
    "thread_task_change_ledger_unavailable",
    {
      cause: error,
    },
  );
}
