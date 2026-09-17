import assert from "node:assert/strict";
import test from "node:test";
import { AgentKernelError } from "@crewon/agent-kernel";
import type { ContextCompactionResult } from "@crewon/context";
import { aggregateCompactionResults } from "./compaction-result-aggregate.ts";
const result = (
  usage: ContextCompactionResult["usage"],
): ContextCompactionResult => ({ summary: "summary", usage });
const reported = {
  inputTokens: 100,
  cachedInputTokens: 80,
  cachedInputTokensReported: true,
  outputTokens: 10,
  totalTokens: 110,
} as const;

test("mixed cache coverage retains known tokens without claiming a fully reported aggregate", () => {
  const mixed = aggregateCompactionResults(
    [
      result(reported),
      result({
        ...reported,
        cachedInputTokens: 0,
        cachedInputTokensReported: false,
      }),
    ],
    32768,
  );
  assert.equal(mixed.usage.inputTokens, 200);
  assert.equal(mixed.usage.cachedInputTokens, 80);
  assert.equal(mixed.usage.cachedInputTokensReported, undefined);
  assert.equal(mixed.usage.totalTokens, 220);
});

test("invalid or overflowing aggregate usage is not silently committed", () => {
  for (const usage of [
    { ...reported, cachedInputTokensReported: false },
    {
      ...reported,
      inputTokens: Number.MAX_SAFE_INTEGER,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: Number.MAX_SAFE_INTEGER,
    },
    { ...reported, totalTokens: 10 },
    { ...reported, outputTokens: NaN },
  ])
    assert.throws(
      () =>
        aggregateCompactionResults([result(reported), result(usage)], 32768),
      (error) =>
        error instanceof AgentKernelError &&
        error.code === "compaction_usage_invalid",
    );
});
