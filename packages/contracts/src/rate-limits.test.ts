import assert from "node:assert/strict";
import test from "node:test";

import { ContractValidationError } from "./contract-validation-error.ts";
import { parseRateLimitSnapshot } from "./rate-limits.ts";

const snapshot = {
  limitId: "codex",
  limitName: null,
  primary: { usedPercent: 100, windowMinutes: 15, resetsAt: null },
  secondary: { usedPercent: 87.5, windowMinutes: 60, resetsAt: null },
  credits: null,
  individualLimit: null,
  planType: null,
  rateLimitReachedType: null,
} as const;

test("parses a bounded provider-neutral rate-limit snapshot", () => {
  assert.deepEqual(parseRateLimitSnapshot(snapshot), snapshot);
});

test("rejects unknown fields and unsafe rate-limit values", () => {
  assert.throws(
    () => parseRateLimitSnapshot({ ...snapshot, providerBody: "secret" }),
    hasCode("rate_limit_snapshot_invalid"),
  );
  assert.throws(
    () =>
      parseRateLimitSnapshot({
        ...snapshot,
        primary: { ...snapshot.primary, usedPercent: 101 },
      }),
    hasCode("rate_limit_primary_invalid"),
  );
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ContractValidationError && error.code === code;
}
