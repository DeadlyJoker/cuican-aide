export const RUN_RATE_LIMIT_REACHED_TYPES = [
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
] as const;

export type RunRateLimitSnapshot = Readonly<{
  limitId: string | null;
  limitName: string | null;
  primary: RunRateLimitWindow | null;
  secondary: RunRateLimitWindow | null;
  credits: RunCreditsSnapshot | null;
  individualLimit: RunSpendControlLimitSnapshot | null;
  planType: string | null;
  rateLimitReachedType: (typeof RUN_RATE_LIMIT_REACHED_TYPES)[number] | null;
}>;

type RunRateLimitWindow = Readonly<{
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}>;

type RunCreditsSnapshot = Readonly<{
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}>;

type RunSpendControlLimitSnapshot = Readonly<{
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAt: number;
}>;

export function runRateLimitSnapshotError(input: unknown): string | null {
  if (
    !isPlainObject(input) ||
    !sameKeys(input, [
      "credits",
      "individualLimit",
      "limitId",
      "limitName",
      "planType",
      "primary",
      "rateLimitReachedType",
      "secondary",
    ])
  ) {
    return "rate_limit_snapshot_invalid";
  }
  if (
    !nullableString(input.limitId, 128) ||
    !nullableString(input.limitName, 256) ||
    !nullableString(input.planType, 64) ||
    !windowValid(input.primary) ||
    !windowValid(input.secondary) ||
    !creditsValid(input.credits) ||
    !individualLimitValid(input.individualLimit) ||
    (input.rateLimitReachedType !== null &&
      (typeof input.rateLimitReachedType !== "string" ||
        !RUN_RATE_LIMIT_REACHED_TYPES.includes(
          input.rateLimitReachedType as (typeof RUN_RATE_LIMIT_REACHED_TYPES)[number],
        )))
  ) {
    return "rate_limit_snapshot_invalid";
  }
  return null;
}

function windowValid(value: unknown): boolean {
  return (
    value === null ||
    (isPlainObject(value) &&
      sameKeys(value, ["resetsAt", "usedPercent", "windowMinutes"]) &&
      typeof value.usedPercent === "number" &&
      Number.isFinite(value.usedPercent) &&
      value.usedPercent >= 0 &&
      value.usedPercent <= 100 &&
      nullableNonNegativeInteger(value.windowMinutes) &&
      nullableNonNegativeInteger(value.resetsAt))
  );
}

function creditsValid(value: unknown): boolean {
  return (
    value === null ||
    (isPlainObject(value) &&
      sameKeys(value, ["balance", "hasCredits", "unlimited"]) &&
      typeof value.hasCredits === "boolean" &&
      typeof value.unlimited === "boolean" &&
      nullableString(value.balance, 128))
  );
}

function individualLimitValid(value: unknown): boolean {
  return (
    value === null ||
    (isPlainObject(value) &&
      sameKeys(value, ["limit", "remainingPercent", "resetsAt", "used"]) &&
      boundedString(value.limit, 128) &&
      boundedString(value.used, 128) &&
      Number.isSafeInteger(value.remainingPercent) &&
      Number(value.remainingPercent) >= 0 &&
      Number(value.remainingPercent) <= 100 &&
      Number.isSafeInteger(value.resetsAt) &&
      Number(value.resetsAt) >= 0)
  );
}

function nullableString(value: unknown, maxLength: number): boolean {
  return value === null || boundedString(value, maxLength);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function nullableNonNegativeInteger(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
