import { AgentKernelError } from "@crewon/agent-kernel";
import type { ContextHistoryItem } from "@crewon/context";

/** At most four overflow failures per compaction; successful parts have a separate fixed bound. */
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
