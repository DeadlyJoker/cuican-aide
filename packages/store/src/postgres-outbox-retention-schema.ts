export function postgresOutboxRetentionSchemaSql(schema: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${schema}.outbox_deduplication (
      message_id text PRIMARY KEY, tenant_id text NOT NULL, run_id text NOT NULL, replay_message_json jsonb
    );
    CREATE INDEX IF NOT EXISTS outbox_delivered_retention_idx
      ON ${schema}.outbox(delivered_at, outbox_order) WHERE status = 'delivered';
    CREATE TABLE IF NOT EXISTS ${schema}.outbox_maintenance (
      singleton integer PRIMARY KEY CHECK (singleton = 1), next_due timestamptz NOT NULL
    );
    INSERT INTO ${schema}.outbox_maintenance VALUES (1, '-infinity') ON CONFLICT DO NOTHING;
    CREATE OR REPLACE FUNCTION ${schema}.outbox_register_message_id() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW.message_id != OLD.message_id OR NEW.tenant_id != OLD.tenant_id OR NEW.run_id != OLD.run_id THEN
            RAISE EXCEPTION 'outbox_message_conflict';
          END IF;
          RETURN NEW;
        END IF;
        BEGIN
          INSERT INTO ${schema}.outbox_deduplication (message_id, tenant_id, run_id) VALUES (NEW.message_id, NEW.tenant_id, NEW.run_id);
        EXCEPTION WHEN unique_violation THEN
          RAISE EXCEPTION 'outbox_message_conflict';
        END;
        RETURN NEW;
      END $$;
    DROP TRIGGER IF EXISTS outbox_register_message_id ON ${schema}.outbox;
    CREATE TRIGGER outbox_register_message_id BEFORE INSERT OR UPDATE OF message_id, tenant_id, run_id ON ${schema}.outbox
      FOR EACH ROW EXECUTE FUNCTION ${schema}.outbox_register_message_id();
  `;
}
