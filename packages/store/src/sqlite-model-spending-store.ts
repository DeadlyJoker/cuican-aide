import type { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  type ModelSpendingStore,
  type SetModelSpendingInput,
} from "@crewon/application";
import type {
  ModelCallRecord,
  ModelUsageRecord,
  ModelSpendingScope,
  ModelSpendingAccount,
  RunState,
} from "@crewon/domain";
import { modelCallKey } from "./model-call-store-support.ts";
import { stableJson } from "./store-invariants.ts";
import {
  configureSpending,
  decodeSpendingAccount,
  decodeSpendingReservation,
  spendingKey,
  reserveSpending,
  settleSpending,
  validateSpendingUpdate,
  spendingInputCeiling,
} from "./model-spending-support.ts";

function read(db: DatabaseSync, scope: ModelSpendingScope) {
  const key = spendingKey(scope);
  const row = db
    .prepare(
      "SELECT CASE WHEN length(CAST(state_json AS BLOB))<=4096 THEN state_json ELSE '{}' END AS state_json FROM model_spending_accounts WHERE account_key=?",
    )
    .get(key);
  const account = decodeSpendingAccount(row?.state_json);
  if (account !== null && spendingKey(account) !== key)
    throw new RunStoreError("model_spending_account_invalid");
  return account;
}
function write(db: DatabaseSync, account: ModelSpendingAccount) {
  db.prepare(
    "INSERT INTO model_spending_accounts(account_key,tenant_id,thread_id,goal_id,state_json) VALUES(?,?,?,?,?) ON CONFLICT(account_key) DO UPDATE SET state_json=excluded.state_json",
  ).run(
    spendingKey(account),
    account.tenantId,
    account.threadId,
    account.goalId,
    stableJson(account),
  );
}
export class SqliteModelSpendingStore implements ModelSpendingStore {
  readonly db: DatabaseSync;
  readonly assertOpen: () => void;
  constructor(db: DatabaseSync, assertOpen: () => void) {
    this.db = db;
    this.assertOpen = assertOpen;
  }
  async get(scope: ModelSpendingScope) {
    this.assertOpen();
    return read(this.db, scope);
  }
  async set(input: SetModelSpendingInput) {
    this.assertOpen();
    validateSpendingUpdate(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const before = read(this.db, input);
      if (before === null) {
        const goal = this.db
          .prepare(
            "SELECT goal_id FROM thread_goals WHERE tenant_id=? AND thread_id=?",
          )
          .get(input.tenantId, input.threadId);
        if (goal?.goal_id !== input.goalId)
          throw new RunStoreError("model_spending_goal_changed");
      }
      const next = configureSpending(before, input, new Date().toISOString());
      if (next !== before) write(this.db, next);
      this.db.exec("COMMIT");
      return next;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
/** Runs inside the call's existing write/lease transaction, before its INSERT and any model I/O. */
export function reserveSqliteModelSpending(
  db: DatabaseSync,
  call: ModelCallRecord,
  run: RunState,
): void {
  if (call.observation.operation !== "generate" || run.threadId === null)
    return;
  const goalId =
    call.goalAttribution?.goalId ??
    run.goalAccounting?.attribution?.goalId ??
    run.goalBinding?.goalId ??
    db
      .prepare(
        "SELECT goal_id FROM thread_goals WHERE tenant_id=? AND thread_id=?",
      )
      .get(run.tenantId, run.threadId)?.goal_id;
  if (typeof goalId !== "string") return;
  const scope = { tenantId: run.tenantId, threadId: run.threadId, goalId },
    account = read(db, scope);
  if (account === null) return;
  if (
    call.goalAttribution === undefined &&
    run.goalBinding !== null &&
    run.goalAccounting === null
  )
    throw new RunStoreError("model_spending_attribution_unknown");
  const model = db
    .prepare(
      "SELECT CASE WHEN length(CAST(model AS BLOB))<=2048 THEN model ELSE NULL END AS model FROM (SELECT json_extract(json_extract(asset_json,'$.definitionJson'),'$.model') AS model FROM agent_versions WHERE tenant_id=? AND agent_version_id=?)",
    )
    .get(call.tenantId, call.observation.agentVersionId)?.model;
  if (typeof model !== "string" || Buffer.byteLength(model) > 2048)
    throw new RunStoreError("model_spending_token_bounds_required");
  const next = reserveSpending(
    account,
    call,
    spendingInputCeiling(call, JSON.parse(model)),
  );
  write(db, next.account);
  db.prepare(
    "INSERT INTO model_spending_reservations(call_key,account_key,state_json) VALUES(?,?,?)",
  ).run(modelCallKey(call), spendingKey(scope), stableJson(next.reservation));
}
/** Canonical usage identity is already validated by the enclosing usage transaction. */
export function settleSqliteModelSpending(
  db: DatabaseSync,
  usage: ModelUsageRecord,
): void {
  const callId = usage.generation?.callId;
  if (callId === undefined) return;
  const key = modelCallKey({ ...usage, observation: { callId } });
  const row = db
    .prepare(
      "SELECT account_key,CASE WHEN length(CAST(state_json AS BLOB))<=2048 THEN state_json ELSE '{}' END AS state_json FROM model_spending_reservations WHERE call_key=?",
    )
    .get(key);
  if (row === undefined) return;
  const reservation = decodeSpendingReservation(row.state_json);
  if (
    reservation === null ||
    spendingKey(reservation.account) !== row.account_key
  )
    throw new RunStoreError("model_spending_reservation_invalid");
  const account = read(db, reservation.account);
  if (account === null)
    throw new RunStoreError("model_spending_account_invalid");
  const next = settleSpending(account, reservation, usage);
  if (next === null) return;
  write(db, next.account);
  db.prepare(
    "UPDATE model_spending_reservations SET state_json=? WHERE call_key=?",
  ).run(stableJson(next.reservation), key);
}
