import type { CommandExecutionIntent } from "../../lib/thread/threadRuntimeSettings";

export type CommandExecutionIntentSelection = {
  intent: CommandExecutionIntent;
  revision: number;
  scopeKey: string;
};

export type PendingCommandExecutionIntent = Omit<
  CommandExecutionIntentSelection,
  "intent"
> & {
  adoptCreatedThreadScope: boolean;
  intent: Exclude<CommandExecutionIntent, "none">;
  sourceThreadId: string | null;
};

export function nextExecutionIntent(
  current: CommandExecutionIntent,
  selected: Exclude<CommandExecutionIntent, "none">,
): CommandExecutionIntent {
  return current === selected ? "none" : selected;
}

export function commandExecutionIntentScopeKey({
  shouldCreateNewThread,
  selectedThreadId,
}: {
  shouldCreateNewThread: boolean;
  selectedThreadId: string | null;
}): string {
  return shouldCreateNewThread || selectedThreadId === null
    ? "draft:new-task"
    : `thread:${selectedThreadId}`;
}

export function executionIntentSelectionAfterCommit(
  current: CommandExecutionIntentSelection,
  committed: Omit<CommandExecutionIntentSelection, "intent"> & {
    intent: Exclude<CommandExecutionIntent, "none">;
  },
): CommandExecutionIntentSelection {
  return current.intent === committed.intent &&
    current.revision === committed.revision &&
    current.scopeKey === committed.scopeKey
    ? { ...current, intent: "none", revision: current.revision + 1 }
    : current;
}

export function executionIntentSelectionForScopeChange({
  current,
  nextScopeKey,
  pending,
  submissionPending,
}: {
  current: CommandExecutionIntentSelection;
  nextScopeKey: string;
  pending: PendingCommandExecutionIntent | null;
  submissionPending: boolean;
}): {
  pending: PendingCommandExecutionIntent | null;
  selection: CommandExecutionIntentSelection;
} {
  if (current.scopeKey === nextScopeKey) {
    return { pending, selection: current };
  }
  const pendingMatchesSelection =
    pending !== null &&
    pending.intent === current.intent &&
    pending.revision === current.revision &&
    pending.scopeKey === current.scopeKey;
  const nextThreadId = nextScopeKey.startsWith("thread:")
    ? nextScopeKey.slice("thread:".length)
    : null;
  if (
    pendingMatchesSelection &&
    pending.adoptCreatedThreadScope &&
    nextThreadId !== null
  ) {
    // A new-task submission can briefly expose the previously selected thread
    // after the draft closes. Wait for the actually-created thread while the
    // request is pending; on failure, restore the intent to the source thread.
    if (nextThreadId === pending.sourceThreadId && submissionPending) {
      return { pending, selection: current };
    }
    return {
      pending: {
        ...pending,
        adoptCreatedThreadScope: false,
        scopeKey: nextScopeKey,
      },
      selection: { ...current, scopeKey: nextScopeKey },
    };
  }
  return {
    pending: null,
    selection: {
      intent: "none",
      revision: current.revision + 1,
      scopeKey: nextScopeKey,
    },
  };
}
