import { useEffect, useRef, useState } from "react";
import type { CommandExecutionIntent } from "../../lib/thread/threadRuntimeSettings";
import {
  executionIntentSelectionAfterCommit,
  executionIntentSelectionForChoice,
  executionIntentSelectionForScopeChange,
  type CommandExecutionIntentSelection,
  type PendingCommandExecutionIntent,
} from "./composerExecutionIntentSelection";

/** Keeps a pending choice scoped to its draft, including a failed send/retry. */
export function useComposerExecutionIntent({
  scopeKey,
  isSending,
  committed,
}: {
  scopeKey: string;
  isSending: boolean;
  committed: { intent: Exclude<CommandExecutionIntent, "none"> } | null;
}) {
  const [selection, setSelection] = useState<CommandExecutionIntentSelection>(
    () => ({ intent: "none", revision: 0, scopeKey }),
  );
  const pendingRef = useRef<PendingCommandExecutionIntent | null>(null);
  const value = selection.scopeKey === scopeKey ? selection.intent : "none";
  useEffect(() => {
    const transition = executionIntentSelectionForScopeChange({
      current: selection,
      nextScopeKey: scopeKey,
      pending: pendingRef.current,
      submissionPending: isSending,
    });
    pendingRef.current = transition.pending;
    if (transition.selection !== selection) setSelection(transition.selection);
  }, [scopeKey, selection, isSending]);
  useEffect(() => {
    const submitted = pendingRef.current;
    if (committed !== null && submitted?.intent === committed.intent) {
      setSelection((current) =>
        executionIntentSelectionAfterCommit(current, submitted),
      );
      pendingRef.current = null;
    }
  }, [committed]);
  return {
    value,
    selection,
    pendingRef,
    select(intent: CommandExecutionIntent) {
      if (isSending) return;
      pendingRef.current = null;
      setSelection((current) =>
        executionIntentSelectionForChoice(current, { intent, scopeKey }),
      );
    },
  };
}
