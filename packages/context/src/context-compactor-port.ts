import type { ContextHistoryItem } from "./normalize-context-history.ts";

export const CONTEXT_COMPACTION_PROMPT =
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\nInclude:\n- Current progress and key decisions made\n- Important context, constraints, or user preferences\n- What remains to be done (clear next steps)\n- Any critical data, examples, or references needed to continue\n\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work.";

export type ContextCompactionContract = Readonly<{
  runId: string;
  segmentId: string;
  attempt: number;
  agentVersionId: string;
  policySnapshotId: string;
  history: readonly ContextHistoryItem[];
  maxOutputBytes: number;
}>;

export type ContextCompactionResult = Readonly<{
  summary: string;
  usage: Readonly<{
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>;
}>;

/** Model-facing compaction boundary; implementations cannot mutate durable history. */
export interface ContextCompactorPort {
  compact(
    contract: ContextCompactionContract,
    signal: AbortSignal,
  ): Promise<ContextCompactionResult>;
}
