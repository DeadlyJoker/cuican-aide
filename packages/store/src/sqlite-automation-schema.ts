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

    CREATE TABLE IF NOT EXISTS automation_schedule_claims (
      tenant_id TEXT NOT NULL,
      automation_id TEXT NOT NULL,
      schedule_revision INTEGER NOT NULL CHECK (schedule_revision = 1),
      scheduled_for TEXT NOT NULL,
      occurrence_digest TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      lease_owner_id TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 1),
      lease_expires_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, automation_id),
      UNIQUE (tenant_id, lease_id),
      FOREIGN KEY (tenant_id, automation_id)
        REFERENCES automations(tenant_id, automation_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS automation_scheduled_invocation_receipts (
      tenant_id TEXT NOT NULL,
      automation_id TEXT NOT NULL,
      schedule_revision INTEGER NOT NULL CHECK (schedule_revision = 1),
      scheduled_for TEXT NOT NULL,
      occurrence_digest TEXT NOT NULL,
      invocation_scope TEXT NOT NULL,
      invocation_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, automation_id, schedule_revision, scheduled_for),
      UNIQUE (tenant_id, occurrence_digest),
      FOREIGN KEY (tenant_id, automation_id)
        REFERENCES automations(tenant_id, automation_id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, invocation_scope, invocation_key)
        REFERENCES automation_invocation_receipts(tenant_id, scope, idempotency_key)
        ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES run_snapshots(tenant_id, run_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS automations_tenant_space_updated_idx
      ON automations(tenant_id, space_id, updated_at DESC, automation_id DESC);
    CREATE INDEX IF NOT EXISTS automations_tenant_thread_idx
      ON automations(tenant_id, thread_id, automation_id);
    CREATE INDEX IF NOT EXISTS automation_invocation_receipts_run_idx
      ON automation_invocation_receipts(tenant_id, run_id);
    CREATE INDEX IF NOT EXISTS automation_schedule_claims_expiry_idx
      ON automation_schedule_claims(lease_expires_at, automation_id);
    CREATE INDEX IF NOT EXISTS automation_scheduled_receipts_run_idx
      ON automation_scheduled_invocation_receipts(tenant_id, run_id);
  `;
}

export function migrateSqliteAutomationAuthority(database: DatabaseSync): void {
  database.exec(sqliteAutomationTablesSql());
}
