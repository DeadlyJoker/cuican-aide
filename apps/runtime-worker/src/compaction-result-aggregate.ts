import { AgentKernelError } from "@crewon/agent-kernel";
import { cacheReadReportingError } from "@crewon/domain";
import type { ContextCompactionResult } from "@crewon/context";
import {
  COMPACTION_PART_HEADER,
  COMPACTION_PART_SEPARATOR,
} from "./compaction-source-plan.ts";

/** Only successful source summaries enter the canonical result; the observation ledger owns all attempts. */
export function aggregateCompactionResults(
  results: readonly ContextCompactionResult[],
  maxOutputBytes: number,
): ContextCompactionResult {
  if (results.length === 1) return results[0]!;
  const summary =
    COMPACTION_PART_HEADER +
    results.map((result) => result.summary).join(COMPACTION_PART_SEPARATOR);
  if (Buffer.byteLength(summary, "utf8") > maxOutputBytes)
    throw new AgentKernelError("compaction_output_limit_exceeded", false);
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  for (const result of results) {
    if (
      cacheReadReportingError(result.usage) !== null ||
      result.usage.cachedInputTokens > result.usage.inputTokens ||
      result.usage.totalTokens !==
        result.usage.inputTokens + result.usage.outputTokens
    )
      throw new AgentKernelError("compaction_usage_invalid", false);
    for (const key of [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "totalTokens",
    ] as const) {
      const value = result.usage[key];
      if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        !Number.isSafeInteger(usage[key] + value)
      )
        throw new AgentKernelError("compaction_usage_invalid", false);
      usage[key] += value;
    }
  }
  // A partly reported aggregate cannot claim full coverage. Keep known cached tokens,
  // but omit the legacy aggregate flag; individual reports retain exact coverage.
  const reported = results.every(
    (result) => result.usage.cachedInputTokensReported === true,
  )
    ? true
    : results.every(
          (result) => result.usage.cachedInputTokensReported === false,
        )
      ? false
      : undefined;
  return {
    summary,
    usage: {
      ...usage,
      ...(reported === undefined
        ? {}
        : { cachedInputTokensReported: reported }),
    },
  };
}
