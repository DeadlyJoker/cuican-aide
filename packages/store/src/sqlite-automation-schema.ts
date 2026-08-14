import { DatabaseSync } from "node:sqlite";

export function sqliteAutomationTablesSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS automations (
      tenant_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      automation_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision = 1),
      definition_digest TEXT NOT NULL,
      definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
      schedule_state_json TEXT NOT NULL CHECK (json_valid(schedule_state_json)),
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, automation_id),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES threads(tenant_id, thread_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS automation_create_receipts (
      tenant_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      automation_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      PRIMARY KEY (tenant_id, scope, idempotency_key),
      FOREIGN KEY (tenant_id, automation_id)
        REFERENCES automations(tenant_id, automation_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS automation_invocation_receipts (
      tenant_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      automation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      PRIMARY KEY (tenant_id, scope, idempotency_key),
      FOREIGN KEY (tenant_id, automation_id)
        REFERENCES automations(tenant_id, automation_id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES run_snapshots(tenant_id, run_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS automations_tenant_space_updated_idx
      ON automations(tenant_id, space_id, updated_at DESC, automation_id DESC);
    CREATE INDEX IF NOT EXISTS automations_tenant_thread_idx
      ON automations(tenant_id, thread_id, automation_id);
    CREATE INDEX IF NOT EXISTS automation_invocation_receipts_run_idx
      ON automation_invocation_receipts(tenant_id, run_id);
  `;
}

export function migrateSqliteAutomationAuthority(database: DatabaseSync): void {
  database.exec(sqliteAutomationTablesSql());
}
