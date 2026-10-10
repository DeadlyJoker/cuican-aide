import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import type { ControlPendingReplyDraft } from "./controlRunPendingReplyDraft";
import type { ControlRunTerminal } from "./controlRunSettlement";

type SynchronizingTurn = Turn & {
  controlCanonicalSyncPending?: true;
  controlPendingReplyDraft?: ControlPendingReplyDraft;
};
type SynchronizingThread = Thread & {
  controlCanonicalSyncRunIds?: readonly string[];
};

export function controlPendingReplyDraft(
  turn: Turn,
): ControlPendingReplyDraft | null {
  return (turn as SynchronizingTurn).controlPendingReplyDraft ?? null;
}

export function updateControlPendingReplyDraft(
  thread: Thread,
  runId: string,
  preview: ControlPendingReplyDraft | null,
): Thread {
  return {
    ...thread,
    turns: thread.turns.map((turn) => {
      if (
        turn.id !== runId ||
        !(turn as SynchronizingTurn).controlCanonicalSyncPending
      )
        return turn;
      const { controlPendingReplyDraft: _prior, ...current } =
        turn as SynchronizingTurn;
      return {
        ...current,
        ...(preview ? { controlPendingReplyDraft: preview } : {}),
      };
    }),
  };
}

export function controlThreadHasPendingCanonicalSync(
  thread: Thread | null,
): boolean {
  return (
    (Boolean(
      (thread as SynchronizingThread | null)?.controlCanonicalSyncRunIds
        ?.length,
    ) ||
      thread?.turns.some(
        (turn) =>
          (turn as SynchronizingTurn).controlCanonicalSyncPending === true,
      )) ??
    false
  );
}

/** Update execution status only; all items and durable identifiers stay intact. */
export function presentControlRunTerminal(
  thread: Thread,
  runId: string,
  terminal: ControlRunTerminal,
): Thread {
  const hasTargetTurn = thread.turns.some((turn) => turn.id === runId);
  const completedAt =
    terminal.terminalAt === null
      ? null
      : Math.floor(Date.parse(terminal.terminalAt) / 1_000);
  const turns = thread.turns.map(
    (turn): SynchronizingTurn =>
      turn.id !== runId
        ? turn
        : {
            ...turn,
            controlCanonicalSyncPending: true,
            ...(terminal.draftPreview
              ? { controlPendingReplyDraft: terminal.draftPreview }
              : {}),
            status:
              terminal.status === "canceled" ? "interrupted" : terminal.status,
            error:
              terminal.status === "failed"
                ? {
                    message: terminal.failure?.code ?? "control_run_failed",
                    codexErrorInfo: null,
                    additionalDetails: null,
                  }
                : null,
            completedAt,
            durationMs:
              completedAt === null || turn.startedAt === null
                ? null
                : Math.max(0, (completedAt - turn.startedAt) * 1_000),
          },
  );
  return {
    ...thread,
    controlCanonicalSyncRunIds: [
      ...new Set([
        ...((thread as SynchronizingThread).controlCanonicalSyncRunIds ?? []),
        runId,
      ]),
    ],
    turns,
    status:
      hasTargetTurn &&
      thread.status.type === "active" &&
      !turns.some((turn) => turn.status === "inProgress")
        ? { type: "idle" }
        : thread.status,
  } as SynchronizingThread;
}

/** A concurrent page/catalog read cannot downgrade a trusted terminal receipt. */
export function preserveControlRunSynchronizations(
  current: Thread | undefined,
  incoming: Thread,
  pendingRunIds: ReadonlySet<string>,
): Thread {
  if (pendingRunIds.size === 0) return incoming;
  const turns = incoming.turns.map((turn): SynchronizingTurn => {
    if (!pendingRunIds.has(turn.id)) return turn;
    const prior = current?.turns.find((item) => item.id === turn.id);
    return {
      ...turn,
      ...(prior && prior.status !== "inProgress"
        ? {
            status: prior.status,
            error: prior.error,
            completedAt: prior.completedAt,
            durationMs: prior.durationMs,
          }
        : {}),
      controlCanonicalSyncPending: true,
      ...((prior as SynchronizingTurn | undefined)?.controlPendingReplyDraft
        ? {
            controlPendingReplyDraft: (prior as SynchronizingTurn)
              .controlPendingReplyDraft,
          }
        : {}),
    };
  });
  return {
    ...incoming,
    turns,
    controlCanonicalSyncRunIds: [...pendingRunIds],
    status:
      incoming.status.type === "active" &&
      !turns.some((turn) => turn.status === "inProgress") &&
      incoming.turns.some((turn) => pendingRunIds.has(turn.id))
        ? { type: "idle" }
        : incoming.status,
  } as SynchronizingThread;
}

export function clearControlRunSynchronization(
  thread: Thread,
  runId?: string,
): Thread {
  const { controlCanonicalSyncRunIds: priorIds, ...base } =
    thread as SynchronizingThread;
  const ids =
    runId === undefined ? [] : (priorIds?.filter((id) => id !== runId) ?? []);
  return {
    ...base,
    ...(ids.length ? { controlCanonicalSyncRunIds: ids } : {}),
    turns: thread.turns.map((turn) => {
      if (runId !== undefined && turn.id !== runId) return turn;
      const {
        controlCanonicalSyncPending: _pending,
        controlPendingReplyDraft: _draft,
        ...canonical
      } = turn as SynchronizingTurn;
      return canonical;
    }),
  };
}
