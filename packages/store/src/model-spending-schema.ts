import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { RunStoreError } from "@crewon/application";

const triggers = ["model_spending_admission", "model_spending_price_fence"];
export function modelSpendingSchemaSql(input: {
  postgres: boolean;
  schema?: string;
}): string {
  const { postgres } = input,
    schema = input.schema ?? "";
  const prefix = schema ? `${schema}.` : "";
  const json = postgres ? "jsonb" : "TEXT";
  const bytes = (column: string) =>
    postgres
      ? `octet_length(${column}::text)`
      : `length(CAST(${column} AS BLOB))`;
  const field = (column: string, path: string[]) =>
    postgres
      ? `${column}#>>'{${path.join(",")}}'`
      : `json_extract(${column},'$.${path.join(".")}')`;
  const operation = field("NEW.record_json", ["observation", "operation"]);
  const price = (which: string) =>
    postgres
      ? `${which}.record_json->'tokenPricing'`
      : `json_extract(${which}.record_json,'$.tokenPricing')`;
  const active = `EXISTS(SELECT 1 FROM ${prefix}run_snapshots r
    LEFT JOIN ${prefix}thread_goals g ON g.tenant_id=r.tenant_id AND g.thread_id=${field("r.state_json", ["threadId"])}
    JOIN ${prefix}model_spending_accounts a ON a.tenant_id=r.tenant_id AND a.thread_id=${field("r.state_json", ["threadId"])}
      AND a.goal_id=COALESCE(${field("r.state_json", ["goalAccounting", "attribution", "goalId"])},${field("r.state_json", ["goalBinding", "goalId"])},g.goal_id)
    WHERE r.tenant_id=NEW.tenant_id AND r.run_id=NEW.run_id)`;
  const held = `EXISTS(SELECT 1 FROM ${prefix}model_spending_reservations WHERE call_key=NEW.call_key)`;
  const tables = `CREATE TABLE IF NOT EXISTS ${prefix}model_spending_accounts (
    account_key TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL, goal_id TEXT NOT NULL,
    state_json ${json} NOT NULL CHECK(${bytes("state_json")}<=4096), UNIQUE(tenant_id,thread_id,goal_id)
  )${postgres ? "" : " STRICT"};
  CREATE TABLE IF NOT EXISTS ${prefix}model_spending_reservations (
    call_key TEXT PRIMARY KEY REFERENCES ${prefix}model_call_observations(call_key) DEFERRABLE INITIALLY DEFERRED,
    account_key TEXT NOT NULL REFERENCES ${prefix}model_spending_accounts(account_key),
    state_json ${json} NOT NULL CHECK(${bytes("state_json")}<=2048)
  )${postgres ? "" : " STRICT"};
  CREATE INDEX IF NOT EXISTS model_spending_reservation_account ON ${prefix}model_spending_reservations(account_key);`;
  if (!postgres)
    return (
      tables +
      `
    CREATE TRIGGER IF NOT EXISTS model_spending_admission BEFORE INSERT ON model_call_observations
      WHEN ${operation}='generate' AND ${active} AND NOT ${held}
      BEGIN SELECT RAISE(ABORT,'model_spending_reservation_required'); END;
    CREATE TRIGGER IF NOT EXISTS model_spending_price_fence BEFORE UPDATE ON model_call_observations
      WHEN ${held} AND ${price("NEW")} IS NOT ${price("OLD")}
      BEGIN SELECT RAISE(ABORT,'model_spending_price_immutable'); END;`
    );
  return (
    tables +
    `
    CREATE OR REPLACE FUNCTION ${prefix}model_spending_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE spending_thread TEXT;
    BEGIN
      IF TG_OP='INSERT' THEN
        IF ${operation}='generate' THEN
          SELECT ${field("r.state_json", ["threadId"])} INTO spending_thread
            FROM ${prefix}run_snapshots r WHERE r.tenant_id=NEW.tenant_id AND r.run_id=NEW.run_id;
          IF spending_thread IS NOT NULL THEN
            PERFORM pg_advisory_xact_lock(hashtextextended('model-spending:' || NEW.tenant_id || ':' || spending_thread,0));
          END IF;
        END IF;
        IF ${operation}='generate' AND ${active} AND NOT ${held} THEN
          RAISE EXCEPTION 'model_spending_reservation_required';
        END IF;
      ELSIF ${held} AND ${price("NEW")} IS DISTINCT FROM ${price("OLD")} THEN
        RAISE EXCEPTION 'model_spending_price_immutable';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE OR REPLACE TRIGGER model_spending_admission BEFORE INSERT ON ${prefix}model_call_observations
      FOR EACH ROW EXECUTE FUNCTION ${prefix}model_spending_admission_guard();
    CREATE OR REPLACE TRIGGER model_spending_price_fence BEFORE UPDATE ON ${prefix}model_call_observations
      FOR EACH ROW EXECUTE FUNCTION ${prefix}model_spending_admission_guard();`
  );
}
export function assertSqliteSpendingSchema(db: DatabaseSync): void {
  db.prepare(
    "SELECT account_key,tenant_id,thread_id,goal_id,state_json FROM model_spending_accounts LIMIT 0",
  ).all();
  db.prepare(
    "SELECT call_key,account_key,state_json FROM model_spending_reservations LIMIT 0",
  ).all();
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (?,?)",
    )
    .all(...triggers);
  if (rows.length !== triggers.length)
    throw new RunStoreError("model_spending_schema_incomplete");
}
export async function assertPostgresSpendingSchema(
  db: PoolClient,
  schema: string,
): Promise<void> {
  await db.query(
    `SELECT account_key,tenant_id,thread_id,goal_id,state_json FROM ${schema}.model_spending_accounts LIMIT 0`,
  );
  await db.query(
    `SELECT call_key,account_key,state_json FROM ${schema}.model_spending_reservations LIMIT 0`,
  );
  const rows = await db.query(
    `SELECT tgname FROM pg_trigger WHERE tgrelid='${schema}.model_call_observations'::regclass AND tgname=ANY($1::text[]) AND tgenabled='O'`,
    [triggers],
  );
  if (rows.rowCount !== triggers.length)
    throw new RunStoreError("model_spending_schema_incomplete");
}
