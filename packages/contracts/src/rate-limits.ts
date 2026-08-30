import { ContractValidationError } from "./contract-validation-error.ts";

export const RATE_LIMIT_REACHED_TYPES = [
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
] as const;

export type RateLimitReachedType = (typeof RATE_LIMIT_REACHED_TYPES)[number];

export type RateLimitWindow = Readonly<{
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}>;

export type CreditsSnapshot = Readonly<{
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}>;

export type SpendControlLimitSnapshot = Readonly<{
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAt: number;
}>;

export type RateLimitSnapshot = Readonly<{
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: CreditsSnapshot | null;
  individualLimit: SpendControlLimitSnapshot | null;
  planType: string | null;
  rateLimitReachedType: RateLimitReachedType | null;
}>;

export function parseRateLimitSnapshot(input: unknown): RateLimitSnapshot {
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
    throw new ContractValidationError("rate_limit_snapshot_invalid");
  }
  nullableBoundedString(input.limitId, 128, "rate_limit_id_invalid");
  nullableBoundedString(input.limitName, 256, "rate_limit_name_invalid");
  parseWindow(input.primary, "primary");
  parseWindow(input.secondary, "secondary");
  parseCredits(input.credits);
  parseIndividualLimit(input.individualLimit);
  nullableBoundedString(input.planType, 64, "rate_limit_plan_type_invalid");
  if (
    input.rateLimitReachedType !== null &&
    (typeof input.rateLimitReachedType !== "string" ||
      !RATE_LIMIT_REACHED_TYPES.includes(
        input.rateLimitReachedType as RateLimitReachedType,
      ))
  ) {
    throw new ContractValidationError("rate_limit_reached_type_invalid");
  }
  return input as RateLimitSnapshot;
}

function parseWindow(value: unknown, name: string): void {
  if (value === null) {
    return;
  }
  if (
    !isPlainObject(value) ||
    !sameKeys(value, ["resetsAt", "usedPercent", "windowMinutes"]) ||
    typeof value.usedPercent !== "number" ||
    !Number.isFinite(value.usedPercent) ||
    value.usedPercent < 0 ||
    value.usedPercent > 100
  ) {
    throw new ContractValidationError(`rate_limit_${name}_invalid`);
  }
  nullableNonNegativeInteger(
    value.windowMinutes,
    `rate_limit_${name}_window_invalid`,
  );
  nullableNonNegativeInteger(
    value.resetsAt,
    `rate_limit_${name}_reset_invalid`,
  );
}

function parseCredits(value: unknown): void {
  if (value === null) {
    return;
  }
  if (
    !isPlainObject(value) ||
    !sameKeys(value, ["balance", "hasCredits", "unlimited"]) ||
    typeof value.hasCredits !== "boolean" ||
    typeof value.unlimited !== "boolean"
  ) {
    throw new ContractValidationError("rate_limit_credits_invalid");
  }
  nullableBoundedString(value.balance, 128, "rate_limit_balance_invalid");
}

function parseIndividualLimit(value: unknown): void {
  if (value === null) {
    return;
  }
  if (
    !isPlainObject(value) ||
    !sameKeys(value, ["limit", "remainingPercent", "resetsAt", "used"]) ||
    !isBoundedString(value.limit, 128) ||
    !isBoundedString(value.used, 128) ||
    !Number.isSafeInteger(value.remainingPercent) ||
    Number(value.remainingPercent) < 0 ||
    Number(value.remainingPercent) > 100 ||
    !Number.isSafeInteger(value.resetsAt) ||
    Number(value.resetsAt) < 0
  ) {
    throw new ContractValidationError("rate_limit_individual_limit_invalid");
  }
}

function nullableBoundedString(
  value: unknown,
  maxLength: number,
  code: string,
): void {
  if (value !== null && !isBoundedString(value, maxLength)) {
    throw new ContractValidationError(code);
  }
}

function nullableNonNegativeInteger(value: unknown, code: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || Number(value) < 0)) {
    throw new ContractValidationError(code);
  }
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
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
