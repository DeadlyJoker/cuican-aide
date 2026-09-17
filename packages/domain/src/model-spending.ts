/** An opt-in Goal account. Earlier calls are explicitly outside its coverage. */
export type ModelSpendingScope = Readonly<{
  tenantId: string;
  threadId: string;
  goalId: string;
}>;
export type ModelSpendingAccount = ModelSpendingScope &
  Readonly<{
    schemaVersion: "crewon.model-spending.v0";
    /** Configuration revision; usage settlement does not invalidate a settings edit. */
    revision: number;
    currency: string;
    limitPicounits: string;
    chargedPicounits: string;
    reservedPicounits: string;
    calls: number;
    unsettledCalls: number;
    boundaryExceededCalls: number;
    activatedAt: string;
    coverage: "callsAdmittedAfterActivation";
  }>;
export type ModelSpendingReservation = Readonly<{
  account: ModelSpendingScope;
  maximumPicounits: string;
  inputCeilingTokens: number;
  outputCeilingTokens: number;
  chargedPicounits: string | null;
  boundaryExceeded: boolean;
}>;
export const MODEL_SPENDING_ADMISSION_CODES = [
  "model_spending_budget_exhausted",
  "model_spending_price_required",
  "model_spending_currency_mismatch",
  "model_spending_token_bounds_required",
  "model_spending_attribution_unknown",
  "model_spending_boundary_exceeded",
] as const;
export function validModelMoney(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,47})$/.test(value);
}
export function validateModelSpendingScope(scope: ModelSpendingScope): void {
  for (const value of [scope.tenantId, scope.threadId, scope.goalId])
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > 512 ||
      /[\u0000-\u001f]/u.test(value)
    )
      throw new Error("model_spending_scope_invalid");
}
export function validateModelSpendingAccount(
  value: ModelSpendingAccount,
): void {
  validateModelSpendingScope(value);
  if (
    value.schemaVersion !== "crewon.model-spending.v0" ||
    value.coverage !== "callsAdmittedAfterActivation" ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    ![value.chargedPicounits, value.reservedPicounits].every(validModelMoney) ||
    !validModelMoney(value.limitPicounits) ||
    [value.calls, value.unsettledCalls, value.boundaryExceededCalls].some(
      (n) => !Number.isSafeInteger(n) || n < 0,
    ) ||
    value.unsettledCalls > value.calls ||
    value.boundaryExceededCalls > value.calls ||
    typeof value.activatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.activatedAt))
  )
    throw new Error("model_spending_account_invalid");
}
export function validateModelSpendingReservation(
  value: ModelSpendingReservation,
): void {
  validateModelSpendingScope(value.account);
  if (
    !validModelMoney(value.maximumPicounits) ||
    (value.chargedPicounits !== null &&
      !validModelMoney(value.chargedPicounits)) ||
    !Number.isSafeInteger(value.inputCeilingTokens) ||
    value.inputCeilingTokens < 1 ||
    !Number.isSafeInteger(value.outputCeilingTokens) ||
    value.outputCeilingTokens < 1 ||
    value.outputCeilingTokens > value.inputCeilingTokens ||
    typeof value.boundaryExceeded !== "boolean"
  )
    throw new Error("model_spending_reservation_invalid");
}
