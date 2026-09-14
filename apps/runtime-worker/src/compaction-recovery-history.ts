import { AgentKernelError } from "@crewon/agent-kernel";
import type { ContextHistoryItem } from "@crewon/context";

/** Includes the initial Kernel execution; transport retry budgets remain separate. */
export const MAX_COMPACTION_CONTEXT_ATTEMPTS = 4;

export function validateCompactionPrefix(
  history: readonly ContextHistoryItem[],
  protectedPrefixLength: number,
): void {
  if (
    !Number.isSafeInteger(protectedPrefixLength) ||
    protectedPrefixLength < 0 ||
    protectedPrefixLength > history.length ||
    history
      .slice(0, protectedPrefixLength)
      .some((item) => item.type !== "message")
  ) {
    throw new AgentKernelError("compaction_protected_prefix_invalid", false);
  }
}

/**
 * Retains the existing oldest-source fallback, but only at a closed Tool boundary.
 * Governance is never removed and at least one source item must remain.
 * This is a temporary model projection, not a rewrite of canonical history.
 */
export function nextCompactionRecoveryHistory(
  history: readonly ContextHistoryItem[],
  protectedPrefixLength: number,
): readonly ContextHistoryItem[] | null {
  const pending = new Map<string, "function" | "custom">();
  for (let index = protectedPrefixLength; index < history.length; index += 1) {
    const item = history[index]!;
    switch (item.type) {
      case "message":
        // A caller omitting prefix metadata cannot implicitly remove high-priority instructions.
        if (item.role === "system" || item.role === "developer") return null;
        break;
      case "tool_call":
        if (pending.has(item.callId)) return null;
        pending.set(item.callId, item.kind);
        break;
      case "tool_result":
        if (pending.get(item.callId) !== item.kind) return null;
        pending.delete(item.callId);
        break;
    }
    if (pending.size === 0) {
      if (index + 1 === history.length) return null;
      return [
        ...history.slice(0, protectedPrefixLength),
        ...history.slice(index + 1),
      ];
    }
  }
  return null;
}
