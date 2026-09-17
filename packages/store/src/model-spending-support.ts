import { createHash } from "node:crypto";
import { RunStoreError, type SetModelSpendingInput } from "@crewon/application";
import {
  estimateModelTokenCost,
  validModelMoney,
  validateModelSpendingAccount,
  validateModelSpendingScope,
  validateModelSpendingReservation,
  type ModelCallRecord,
  type ModelUsageRecord,
  type RunState,
  type ThreadGoal,
  type ModelSpendingAccount,
  type ModelSpendingReservation,
  type ModelSpendingScope,
} from "@crewon/domain";

export function spendingKey(scope: ModelSpendingScope): string {
  validateModelSpendingScope(scope);
  return createHash("sha256")
    .update(JSON.stringify([scope.tenantId, scope.threadId, scope.goalId]))
    .digest("hex");
}
export function validateSpendingUpdate(input: SetModelSpendingInput): void {
  try {
    validateModelSpendingScope(input);
  } catch {
    throw new RunStoreError("model_spending_scope_invalid");
  }
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    typeof input.currency !== "string" ||
    !/^[A-Z]{3}$/.test(input.currency) ||
    !validModelMoney(input.limitPicounits)
  )
    throw new RunStoreError("model_spending_settings_invalid");
}
export function decodeSpendingAccount(
  value: unknown,
): ModelSpendingAccount | null {
  if (value === undefined || value === null) return null;
  try {
    const account = typeof value === "string" ? JSON.parse(value) : value;
    validateModelSpendingAccount(account);
    return account;
  } catch {
    throw new RunStoreError("model_spending_account_invalid");
  }
}
export function configureSpending(
  before: ModelSpendingAccount | null,
  input: SetModelSpendingInput,
  activatedAt: string,
): ModelSpendingAccount {
  validateSpendingUpdate(input);
  const same =
    before !== null &&
    before.currency === input.currency &&
    before.limitPicounits === input.limitPicounits;
  if ((before?.revision ?? 0) !== input.expectedRevision) {
    if (same && before!.revision === input.expectedRevision + 1) return before!;
    throw new RunStoreError("model_spending_revision_conflict");
  }
  if (same) return before!;
  if (
    before !== null &&
    before.currency !== input.currency &&
    before.calls !== 0
  )
    throw new RunStoreError("model_spending_currency_immutable");
  const next: ModelSpendingAccount = {
    ...(before ?? {
      schemaVersion: "crewon.model-spending.v0",
      tenantId: input.tenantId,
      threadId: input.threadId,
      goalId: input.goalId,
      chargedPicounits: "0",
      reservedPicounits: "0",
      calls: 0,
      unsettledCalls: 0,
      boundaryExceededCalls: 0,
      activatedAt,
      coverage: "callsAdmittedAfterActivation",
    }),
    revision: (before?.revision ?? 0) + 1,
    currency: input.currency,
    limitPicounits: input.limitPicounits,
  };
  validateModelSpendingAccount(next);
  return next;
}
/** Money includes Plan and explicit compaction; the legacy token charging policy remains unchanged. */
export function spendingScope(
  call: ModelCallRecord,
  run: RunState,
  currentGoal: ThreadGoal | null,
): ModelSpendingScope | null {
  if (
    run.tenantId !== call.tenantId ||
    run.runId !== call.runId ||
    run.threadId === null
  )
    throw new RunStoreError("model_spending_run_invalid");
  const goalId =
    call.goalAttribution?.goalId ??
    run.goalAccounting?.attribution?.goalId ??
    run.goalBinding?.goalId ??
    currentGoal?.goalId;
  if (
    currentGoal !== null &&
    (currentGoal.tenantId !== run.tenantId ||
      currentGoal.threadId !== run.threadId)
  )
    throw new RunStoreError("model_spending_run_invalid");
  return goalId === undefined
    ? null
    : { tenantId: run.tenantId, threadId: run.threadId, goalId };
}
export function reserveSpending(
  account: ModelSpendingAccount,
  call: ModelCallRecord,
  inputCeilingTokens: number,
) {
  validateModelSpendingAccount(account);
  if (account.boundaryExceededCalls !== 0)
    throw new RunStoreError("model_spending_boundary_exceeded");
  const quote = call.tokenPricing,
    outputCeilingTokens = call.observation.maxOutputTokens;
  if (quote === undefined || call.observation.transport === "cloudAgent")
    throw new RunStoreError("model_spending_price_required");
  if (quote.price.currency !== account.currency)
    throw new RunStoreError("model_spending_currency_mismatch");
  if (
    !Number.isSafeInteger(inputCeilingTokens) ||
    inputCeilingTokens < 1 ||
    outputCeilingTokens === undefined ||
    !Number.isSafeInteger(outputCeilingTokens) ||
    outputCeilingTokens < 1 ||
    outputCeilingTokens > inputCeilingTokens
  )
    throw new RunStoreError("model_spending_token_bounds_required");
  const maximumPicounits = estimateModelTokenCost(quote, {
    inputTokens: inputCeilingTokens,
    cachedInputTokens: 0,
    cachedInputTokensReported: false,
    outputTokens: outputCeilingTokens,
  }).upperPicounits;
  const reserved = BigInt(account.reservedPicounits) + BigInt(maximumPicounits);
  if (
    reserved + BigInt(account.chargedPicounits) >
    BigInt(account.limitPicounits)
  )
    throw new RunStoreError("model_spending_budget_exhausted");
  const next = {
    ...account,
    reservedPicounits: reserved.toString(),
    calls: account.calls + 1,
    unsettledCalls: account.unsettledCalls + 1,
  };
  validateModelSpendingAccount(next);
  const reservation: ModelSpendingReservation = {
    account: {
      tenantId: account.tenantId,
      threadId: account.threadId,
      goalId: account.goalId,
    },
    maximumPicounits,
    inputCeilingTokens,
    outputCeilingTokens,
    chargedPicounits: null,
    boundaryExceeded: false,
  };
  return { account: next, reservation };
}
export function settleSpending(
  account: ModelSpendingAccount,
  reservation: ModelSpendingReservation,
  usage: ModelUsageRecord,
) {
  validateModelSpendingAccount(account);
  validateModelSpendingReservation(reservation);
  const quote = usage.generation?.tokenPricing;
  if (
    quote === undefined ||
    quote.price.currency !== account.currency ||
    spendingKey(reservation.account) !== spendingKey(account)
  )
    throw new RunStoreError("model_spending_usage_invalid");
  const upper = estimateModelTokenCost(
    quote,
    usage.observation.usage,
  ).upperPicounits;
  const exceeded =
    reservation.boundaryExceeded ||
    usage.observation.usage.inputTokens > reservation.inputCeilingTokens ||
    usage.observation.usage.outputTokens > reservation.outputCeilingTokens ||
    BigInt(upper) > BigInt(reservation.maximumPicounits);
  if (
    reservation.chargedPicounits === upper &&
    reservation.boundaryExceeded === exceeded
  )
    return null;
  const first = reservation.chargedPicounits === null;
  const next = {
    ...account,
    chargedPicounits: (
      BigInt(account.chargedPicounits) -
      BigInt(reservation.chargedPicounits ?? "0") +
      BigInt(upper)
    ).toString(),
    reservedPicounits: (
      BigInt(account.reservedPicounits) -
      (first ? BigInt(reservation.maximumPicounits) : 0n)
    ).toString(),
    unsettledCalls: account.unsettledCalls - Number(first),
    boundaryExceededCalls:
      account.boundaryExceededCalls +
      Number(exceeded && !reservation.boundaryExceeded),
  };
  validateModelSpendingAccount(next);
  return {
    account: next,
    reservation: {
      ...reservation,
      chargedPicounits: upper,
      boundaryExceeded: exceeded,
    },
  };
}
export function decodeSpendingReservation(
  value: unknown,
): ModelSpendingReservation | null {
  if (value === undefined || value === null) return null;
  try {
    const reservation = typeof value === "string" ? JSON.parse(value) : value;
    validateModelSpendingReservation(reservation);
    return reservation;
  } catch {
    throw new RunStoreError("model_spending_reservation_invalid");
  }
}
export function spendingInputCeiling(
  call: ModelCallRecord,
  value: unknown,
): number {
  const model = value as Record<string, unknown> | null;
  const o = call.observation;
  if (
    model === null ||
    typeof model !== "object" ||
    model.adapterName !== o.adapterName ||
    model.adapterVersion !== o.adapterVersion ||
    model.modelId !== o.modelId ||
    model.maxOutputTokens !== o.maxOutputTokens ||
    !Number.isSafeInteger(model.contextWindowTokens) ||
    Number(model.contextWindowTokens) < 1
  )
    throw new RunStoreError("model_spending_token_bounds_required");
  return model.contextWindowTokens as number;
}
