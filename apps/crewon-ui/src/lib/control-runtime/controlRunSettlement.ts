import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { RunEventView, RunView } from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";
import {
  applyControlTaskChangeEvent,
  backfillControlToolProjection,
  controlTaskChangeProjectionComplete,
  controlToolProjectionComplete,
  controlToolItemsWithTaskChanges,
  settleControlToolProjection,
  type ControlRunEventStream,
  type ControlTaskChangeProjectionState,
  type ControlToolHistoryCoverage,
  type ControlToolItem,
  type ControlToolProjectionState,
} from "./controlRunToolProjection";
import type { ControlPendingReplyDraft } from "./controlRunPendingReplyDraft";
import { waitForControlRuntimeDelay } from "./controlRuntimeDelay";

export type ControlRunTerminal = Readonly<{
  status: "completed" | "failed" | "canceled";
  lastSequence: number;
  terminalAt: string | null;
  failure?: RunView["failure"];
  outputRef?: RunView["outputRef"];
  draftPreview?: ControlPendingReplyDraft | null;
}>;

export type ControlCanonicalSyncRetryDelay = (
  attempt: number,
  signal: AbortSignal,
) => Promise<void>;

export function controlRunTerminal(
  receipt: Pick<RunView, "status" | "lastSequence" | "terminalAt"> & {
    failure?: RunView["failure"];
    outputRef?: RunView["outputRef"];
  },
): ControlRunTerminal {
  if (
    !["completed", "failed", "canceled"].includes(receipt.status) ||
    !Number.isSafeInteger(receipt.lastSequence) ||
    receipt.lastSequence < 0 ||
    (receipt.terminalAt !== null &&
      !Number.isFinite(Date.parse(receipt.terminalAt)))
  )
    throw new Error("control_run_terminal_receipt_invalid");
  return { ...receipt, status: receipt.status as ControlRunTerminal["status"] };
}

/**
 * One presentation owner keeps the terminal receipt while a separate reader is
 * released. Only canonical synchronization is retried; execution is never restarted.
 */
export async function synchronizeControlRun(input: {
  client: ControlApiClient;
  eventStream: ControlRunEventStream;
  threadId: string;
  runId: string;
  terminal: ControlRunTerminal;
  signal: AbortSignal;
  toolHistoryTimeoutMs: number;
  toolState: ControlToolProjectionState | undefined;
  taskChangeState: ControlTaskChangeProjectionState | undefined;
  sequence(): number;
  advanceSequence(sequence: number): void;
  isCurrent(): boolean;
  presentsThread(): boolean;
  onDraftEvent(event: RunEventView): void;
  onToolItem(item: ControlToolItem): void;
  onCoverage(
    tool: ControlToolHistoryCoverage,
    task: ControlToolHistoryCoverage | null,
  ): void;
  currentToolItems?(runId: string): readonly ControlToolItem[];
  readCanonical(): Promise<Thread>;
  beforePublish(): Promise<void>;
  publish(thread: Thread): void;
  onSynchronized(): void;
  onSyncError?(error: unknown): void;
  retryDelay?: ControlCanonicalSyncRetryDelay;
}): Promise<void> {
  const { terminal } = input;
  void recoverControlRunHistory(input).catch(() => undefined);
  let attempt = 0;
  let reportedError = false;
  while (input.isCurrent()) {
    try {
      const thread = await input.readCanonical();
      if (!input.isCurrent()) return;
      if (thread.id !== input.threadId)
        throw new Error("control_run_canonical_thread_invalid");
      const turn = thread.turns.find((item) => item.id === input.runId);
      const expectedStatus =
        terminal.status === "canceled" ? "interrupted" : terminal.status;
      if (turn !== undefined && turn.status !== expectedStatus)
        throw new Error("control_run_canonical_terminal_not_observed");
      const outputId =
        terminal.status === "completed" &&
        terminal.outputRef?.startsWith("message:")
          ? terminal.outputRef.slice("message:".length)
          : null;
      // The output may come from a separate bounded history lookup. It must
      // always be the exact durable Message named by the terminal receipt.
      if (
        outputId !== null &&
        (turn === undefined ||
          !(
            turn as Turn & { controlAssistantMessageIds?: readonly string[] }
          ).controlAssistantMessageIds?.includes(outputId))
      )
        throw new Error("control_run_canonical_output_not_observed");
      if (input.presentsThread()) await input.beforePublish();
      if (!input.isCurrent()) return;
      // A missing optional tool result is presented as settled, without mutating
      // the live replay state (late recovered events may still correct it).
      for (const item of input.toolState
        ? settleControlToolProjection(new Map(input.toolState), terminal)
        : [])
        input.onToolItem(item);
      // Recovery can complete while the presentation drain is pending. Merge at
      // publication time, after the gate, so an older snapshot cannot roll it back.
      input.publish(
        refreshCanonicalControlToolResults(
          mergeCurrentRunTools(
            thread,
            input.runId,
            input.toolState,
            input.taskChangeState,
            terminal,
          ),
          input.currentToolItems,
        ),
      );
      input.onSynchronized();
      return;
    } catch (error) {
      if (!input.isCurrent()) return;
      if (!reportedError) {
        reportedError = true;
        input.onSyncError?.(error);
      }
      attempt++;
      try {
        await (input.retryDelay ?? defaultCanonicalSyncRetryDelay)(
          attempt,
          input.signal,
        );
      } catch {
        if (!input.isCurrent()) return;
        throw error;
      }
    }
  }
}

/** A whole-window publication must retain recovered results from every visible Run. */
export function refreshCanonicalControlToolResults(
  thread: Thread,
  currentItems: ((runId: string) => readonly ControlToolItem[]) | undefined,
): Thread {
  if (!currentItems) return thread;
  return {
    ...thread,
    turns: thread.turns.map((turn) => {
      const latest = currentItems(turn.id).filter(
        (item) => item.status !== "inProgress",
      );
      if (!latest.length) return turn;
      const byId = new Map(latest.map((item) => [item.id, item]));
      const present = new Set(turn.items.map((item) => item.id));
      return {
        ...turn,
        items: [
          ...turn.items.map((item) => byId.get(item.id) ?? item),
          ...latest.filter((item) => !present.has(item.id)),
        ],
      };
    }),
  };
}

function mergeCurrentRunTools(
  thread: Thread,
  runId: string,
  state: ControlToolProjectionState | undefined,
  changes: ControlTaskChangeProjectionState | undefined,
  terminal: ControlRunTerminal,
): Thread {
  if (!state) return thread;
  const snapshot = new Map(state);
  settleControlToolProjection(snapshot, terminal);
  const latest = controlToolItemsWithTaskChanges(snapshot, changes);
  const byId = new Map(latest.map((item) => [item.id, item]));
  return {
    ...thread,
    turns: thread.turns.map((turn) => {
      if (turn.id !== runId) return turn;
      const present = new Set(turn.items.map((item) => item.id));
      return {
        ...turn,
        items: [
          ...turn.items.map((item) => byId.get(item.id) ?? item),
          ...latest.filter((item) => !present.has(item.id)),
        ],
      };
    }),
  };
}

export function canonicalControlToolItems(
  state: ControlToolProjectionState | undefined,
  changes: ControlTaskChangeProjectionState | undefined,
  run: RunView,
): ThreadItem[] {
  const projected = state === undefined ? undefined : new Map(state);
  if (projected) settleControlToolProjection(projected, run);
  return controlToolItemsWithTaskChanges(projected, changes);
}

async function recoverControlRunHistory(
  input: Parameters<typeof synchronizeControlRun>[0],
): Promise<void> {
  const { terminal, toolState, taskChangeState } = input;
  let reachedTerminal = input.sequence() >= terminal.lastSequence;
  if (toolState && !reachedTerminal && input.isCurrent()) {
    const changes = new Map<string, ControlToolItem>();
    try {
      // The live network reader was aborted before this replay starts. The
      // presentation owner remains valid and retains already received output.
      const replay = await backfillControlToolProjection({
        client: input.client,
        eventStream: input.eventStream,
        runId: input.runId,
        afterSequence: input.sequence(),
        throughSequence: terminal.lastSequence,
        state: toolState,
        signal: input.signal,
        timeoutMs: input.toolHistoryTimeoutMs,
        onEvent: (event) => {
          if (!input.isCurrent())
            throw new Error("control_run_stream_superseded");
          if (taskChangeState) {
            const item = applyControlTaskChangeEvent(taskChangeState, event);
            if (item) changes.set(item.id, item);
          }
          input.advanceSequence(event.sequence);
          input.onDraftEvent(event);
        },
      });
      if (!input.isCurrent()) return;
      input.advanceSequence(replay.lastSequence);
      reachedTerminal = replay.lastSequence >= terminal.lastSequence;
      const ids = new Set(replay.items.map((item) => item.id));
      for (const item of replay.items) input.onToolItem(item);
      for (const item of changes.values())
        if (!ids.has(item.id)) input.onToolItem(item);
    } catch {
      if (!input.isCurrent()) return;
      // Missing optional event history cannot prevent reading durable messages.
    }
  }
  if (!input.isCurrent()) return;
  if (toolState && reachedTerminal) {
    input.onCoverage(
      {
        throughSequence: terminal.lastSequence,
        complete: controlToolProjectionComplete(toolState),
      },
      taskChangeState
        ? {
            throughSequence: terminal.lastSequence,
            complete: controlTaskChangeProjectionComplete(taskChangeState),
          }
        : null,
    );
  }
  for (const item of toolState
    ? settleControlToolProjection(
        reachedTerminal ? toolState : new Map(toolState),
        terminal,
      )
    : [])
    input.onToolItem(item);
}

function defaultCanonicalSyncRetryDelay(attempt: number, signal: AbortSignal) {
  return waitForControlRuntimeDelay({
    delayMs: Math.min(10_000, 1_000 * 2 ** Math.min(attempt - 1, 4)),
    signal,
  });
}
