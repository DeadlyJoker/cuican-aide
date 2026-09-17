import type { ContextHistoryItem } from "./normalize-context-history.ts";
import type {
  ModelUsageObservationSink,
  ModelCallObservationSink,
} from "@crewon/domain";

export const CONTEXT_COMPACTION_PROMPT =
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\nInclude:\n- Current progress and key decisions made\n- Important context, constraints, or user preferences\n- What remains to be done (clear next steps)\n- Any critical data, examples, or references needed to continue\n\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work.";

export type ContextCompactionContract = Readonly<{
  runId: string;
  segmentId: string;
  attempt: number;
  agentVersionId: string;
  policySnapshotId: string;
  history: readonly ContextHistoryItem[];
  /** Governance message prefix to preserve verbatim during overflow recovery. Defaults to zero for legacy callers. */
  protectedPrefixLength?: number;
  /** Per model request, including governance and the compaction prompt. Never truncates source history. */
  inputLimits?: Readonly<{ maxItems: number; maxBytes: number }>;
  maxOutputBytes: number;
}>;

export type ContextCompactionResult = Readonly<{
  summary: string;
  usage: Readonly<{
    inputTokens: number;
    cachedInputTokens: number;
    /** Absent on legacy compactors; absence is unknown for cache statistics. */
    cachedInputTokensReported?: boolean;
    outputTokens: number;
    totalTokens: number;
  }>;
}>;

/** Scoped by the caller to a leased compaction Step; payload is private staging, never model input. */
export interface ContextCompactionCheckpointPort {
  load(
    contextDigest: string,
  ): Promise<Readonly<{ revision: number; payload: string }> | null>;
  save(
    input: Readonly<{
      contextDigest: string;
      expectedRevision: number;
      payload: string;
    }>,
  ): Promise<number>;
}

/**
 * Model-facing compaction boundary. A successful result must cover the entire supplied
 * history; implementations may partition requests but cannot trim source or mutate
 * durable history. Failure must never return a partial summary as complete.
 */
export interface ContextCompactorPort {
  compact(
    contract: ContextCompactionContract,
    signal: AbortSignal,
    options?: Readonly<{
      usageSink?: ModelUsageObservationSink;
      callSink?: ModelCallObservationSink;
      checkpoint?: ContextCompactionCheckpointPort;
    }>,
  ): Promise<ContextCompactionResult>;
}
