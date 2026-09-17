import {
  RunStoreError,
  type ModelSpendingStore,
  type SetModelSpendingInput,
} from "@crewon/application";
import type {
  ModelSpendingScope,
  ModelSpendingAccount,
  ModelSpendingReservation,
  ModelCallRecord,
  ModelUsageRecord,
  RunState,
  ThreadGoal,
} from "@crewon/domain";
import { modelCallKey } from "./model-call-store-support.ts";
import {
  configureSpending,
  spendingKey,
  spendingScope,
  reserveSpending,
  settleSpending,
  spendingInputCeiling,
  validateSpendingUpdate,
} from "./model-spending-support.ts";
export class InMemoryModelSpendingStore implements ModelSpendingStore {
  readonly #accounts = new Map<string, ModelSpendingAccount>();
  readonly #reservations = new Map<string, ModelSpendingReservation>();
  readonly dependencies: {
    goal(scope: { tenantId: string; threadId: string }): ThreadGoal | null;
    model(call: ModelCallRecord): unknown;
  };
  constructor(dependencies: InMemoryModelSpendingStore["dependencies"]) {
    this.dependencies = dependencies;
  }
  async get(scope: ModelSpendingScope) {
    return structuredClone(this.#accounts.get(spendingKey(scope)) ?? null);
  }
  async set(input: SetModelSpendingInput) {
    validateSpendingUpdate(input);
    const key = spendingKey(input),
      before = this.#accounts.get(key) ?? null;
    if (before === null) {
      const goal = this.dependencies.goal(input);
      if (
        goal?.goalId !== input.goalId ||
        goal.tenantId !== input.tenantId ||
        goal.threadId !== input.threadId
      )
        throw new RunStoreError("model_spending_goal_changed");
    }
    const next = configureSpending(before, input, new Date().toISOString());
    if (next !== before) this.#accounts.set(key, structuredClone(next));
    return structuredClone(next);
  }
  reserve(call: ModelCallRecord, run: RunState): void {
    if (call.observation.operation !== "generate" || run.threadId === null)
      return;
    const scope = spendingScope(
      call,
      run,
      this.dependencies.goal({
        tenantId: run.tenantId,
        threadId: run.threadId,
      }),
    );
    if (scope === null) return;
    const account = this.#accounts.get(spendingKey(scope));
    if (account === undefined) return;
    if (
      call.goalAttribution === undefined &&
      run.goalBinding !== null &&
      run.goalAccounting === null
    )
      throw new RunStoreError("model_spending_attribution_unknown");
    const next = reserveSpending(
      account,
      call,
      spendingInputCeiling(call, this.dependencies.model(call)),
    );
    const key = modelCallKey(call);
    if (this.#reservations.has(key))
      throw new RunStoreError("model_spending_reservation_conflict");
    this.#accounts.set(spendingKey(scope), next.account);
    this.#reservations.set(key, next.reservation);
  }
  settle(usage: ModelUsageRecord): void {
    const callId = usage.generation?.callId;
    if (callId === undefined) return;
    const key = modelCallKey({ ...usage, observation: { callId } }),
      reservation = this.#reservations.get(key);
    if (reservation === undefined) return;
    const account = this.#accounts.get(spendingKey(reservation.account));
    if (account === undefined)
      throw new RunStoreError("model_spending_account_invalid");
    const next = settleSpending(account, reservation, usage);
    if (next === null) return;
    this.#accounts.set(spendingKey(reservation.account), next.account);
    this.#reservations.set(key, next.reservation);
  }
}
