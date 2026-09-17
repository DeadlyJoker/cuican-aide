import type { Pool, PoolClient } from "pg";
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
import {
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";
import { advisoryLock, threadLockKey } from "./postgres-thread-lock.ts";

async function lock(
  db: PoolClient,
  scope: { tenantId: string; threadId: string },
) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `model-spending:${scope.tenantId}:${scope.threadId}`,
  ]);
}
async function read(
  db: Pick<PoolClient, "query">,
  schema: string,
  scope: ModelSpendingScope,
) {
  const key = spendingKey(scope);
  const rows = await db.query(
    `SELECT CASE WHEN octet_length(state_json::text)<=4096 THEN state_json ELSE '{}'::jsonb END AS state_json FROM ${schema}.model_spending_accounts WHERE account_key=$1`,
    [key],
  );
  const account = decodeSpendingAccount(rows.rows[0]?.state_json);
  if (account !== null && spendingKey(account) !== key)
    throw new RunStoreError("model_spending_account_invalid");
  return account;
}
async function write(
  db: PoolClient,
  schema: string,
  account: ModelSpendingAccount,
) {
  await db.query(
    `INSERT INTO ${schema}.model_spending_accounts(account_key,tenant_id,thread_id,goal_id,state_json) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_key) DO UPDATE SET state_json=excluded.state_json`,
    [
      spendingKey(account),
      account.tenantId,
      account.threadId,
      account.goalId,
      stableJson(account),
    ],
  );
}
export class PostgresModelSpendingStore implements ModelSpendingStore {
  readonly pool: Pool;
  readonly schema: string;
  readonly assertOpen: () => void;
  constructor(pool: Pool, schema: string, assertOpen: () => void) {
    this.pool = pool;
    this.schema = schema;
    this.assertOpen = assertOpen;
  }
  async get(scope: ModelSpendingScope) {
    this.assertOpen();
    try {
      return await read(this.pool, this.schema, scope);
    } catch (e) {
      throw normalizePostgresError(e);
    }
  }
  async set(input: SetModelSpendingInput) {
    this.assertOpen();
    validateSpendingUpdate(input);
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      // Goal replacement and budget activation share the Thread mutation fence.
      await advisoryLock(db, threadLockKey(input.tenantId, input.threadId));
      await lock(db, input);
      const before = await read(db, this.schema, input);
      if (before === null) {
        const goal = await db.query(
          `SELECT goal_id FROM ${this.schema}.thread_goals WHERE tenant_id=$1 AND thread_id=$2`,
          [input.tenantId, input.threadId],
        );
        if (goal.rows[0]?.goal_id !== input.goalId)
          throw new RunStoreError("model_spending_goal_changed");
      }
      const next = configureSpending(before, input, new Date().toISOString());
      if (next !== before) await write(db, this.schema, next);
      await db.query("COMMIT");
      return next;
    } catch (e) {
      await rollbackPostgres(db);
      throw normalizePostgresError(e);
    } finally {
      db.release();
    }
  }
}
export async function reservePostgresModelSpending(
  db: PoolClient,
  schema: string,
  call: ModelCallRecord,
  run: RunState,
): Promise<void> {
  if (call.observation.operation !== "generate" || run.threadId === null)
    return;
  await lock(db, { tenantId: run.tenantId, threadId: run.threadId });
  let goalId =
    call.goalAttribution?.goalId ??
    run.goalAccounting?.attribution?.goalId ??
    run.goalBinding?.goalId;
  if (goalId === undefined) {
    const goal = await db.query(
      `SELECT goal_id FROM ${schema}.thread_goals WHERE tenant_id=$1 AND thread_id=$2`,
      [run.tenantId, run.threadId],
    );
    goalId = goal.rows[0]?.goal_id;
  }
  if (goalId === undefined) return;
  const scope = { tenantId: run.tenantId, threadId: run.threadId, goalId },
    account = await read(db, schema, scope);
  if (account === null) return;
  if (
    call.goalAttribution === undefined &&
    run.goalBinding !== null &&
    run.goalAccounting === null
  )
    throw new RunStoreError("model_spending_attribution_unknown");
  const rows = await db.query(
    `SELECT model FROM (SELECT (asset_json->>'definitionJson')::jsonb->'model' AS model FROM ${schema}.agent_versions WHERE tenant_id=$1 AND agent_version_id=$2) v WHERE octet_length(model::text)<=2048`,
    [call.tenantId, call.observation.agentVersionId],
  );
  const next = reserveSpending(
    account,
    call,
    spendingInputCeiling(call, rows.rows[0]?.model ?? null),
  );
  await write(db, schema, next.account);
  await db.query(
    `INSERT INTO ${schema}.model_spending_reservations(call_key,account_key,state_json) VALUES($1,$2,$3)`,
    [modelCallKey(call), spendingKey(scope), stableJson(next.reservation)],
  );
}
export async function settlePostgresModelSpending(
  db: PoolClient,
  schema: string,
  usage: ModelUsageRecord,
): Promise<void> {
  const callId = usage.generation?.callId;
  if (callId === undefined) return;
  const key = modelCallKey({ ...usage, observation: { callId } });
  const rows = await db.query(
    `SELECT account_key,CASE WHEN octet_length(state_json::text)<=2048 THEN state_json ELSE '{}'::jsonb END AS state_json FROM ${schema}.model_spending_reservations WHERE call_key=$1`,
    [key],
  );
  const row = rows.rows[0];
  if (row === undefined) return;
  const reservation = decodeSpendingReservation(row.state_json);
  if (
    reservation === null ||
    spendingKey(reservation.account) !== row.account_key
  )
    throw new RunStoreError("model_spending_reservation_invalid");
  await lock(db, reservation.account);
  const account = await read(db, schema, reservation.account);
  if (account === null)
    throw new RunStoreError("model_spending_account_invalid");
  const next = settleSpending(account, reservation, usage);
  if (next === null) return;
  await write(db, schema, next.account);
  await db.query(
    `UPDATE ${schema}.model_spending_reservations SET state_json=$1 WHERE call_key=$2`,
    [stableJson(next.reservation), key],
  );
}
