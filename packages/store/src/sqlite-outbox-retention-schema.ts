export function sqliteOutboxRetentionSchemaSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS outbox_deduplication (
      message_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, replay_message_json TEXT CHECK (replay_message_json IS NULL OR json_valid(replay_message_json))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS outbox_delivered_retention_idx
      ON outbox(delivered_at_ms, outbox_order) WHERE status = 'delivered';
    CREATE TABLE IF NOT EXISTS outbox_maintenance (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      next_due_ms INTEGER NOT NULL CHECK (next_due_ms >= 0)
    ) STRICT;
    INSERT OR IGNORE INTO outbox_maintenance VALUES (1, 0);
    CREATE TRIGGER IF NOT EXISTS outbox_register_message_id
      BEFORE INSERT ON outbox BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM outbox_deduplication WHERE message_id = NEW.message_id
        ) THEN RAISE(ABORT, 'outbox_message_conflict') END;
        INSERT INTO outbox_deduplication (message_id, tenant_id, run_id) VALUES (NEW.message_id, NEW.tenant_id, NEW.run_id);
      END;
    CREATE TRIGGER IF NOT EXISTS outbox_immutable_message_identity
      BEFORE UPDATE OF message_id, tenant_id, run_id ON outbox
      WHEN NEW.message_id != OLD.message_id OR NEW.tenant_id != OLD.tenant_id OR NEW.run_id != OLD.run_id
      BEGIN SELECT RAISE(ABORT, 'outbox_message_conflict'); END;
  `;
}
