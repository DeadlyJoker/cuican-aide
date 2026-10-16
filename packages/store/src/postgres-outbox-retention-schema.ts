export function postgresOutboxRetentionSchemaSql(schema: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${schema}.outbox_deduplication (
      message_id text PRIMARY KEY, tenant_id text NOT NULL, run_id text NOT NULL, replay_message_json jsonb
    );
    DO $existing_index$ BEGIN
      IF to_regclass('${schema}.outbox_delivered_retention_idx') IS NULL THEN
        CREATE INDEX IF NOT EXISTS outbox_delivered_retention_idx
      ON ${schema}.outbox(delivered_at, outbox_order) WHERE status = 'delivered';
      END IF;
    END $existing_index$;
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
    DO $outbox_trigger$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid='${schema}.outbox'::regclass AND t.tgname='outbox_register_message_id'
          AND t.tgenabled='O' AND t.tgtype=23 AND t.tgqual IS NULL AND t.tgnargs=0
          AND t.tgfoid='${schema}.outbox_register_message_id()'::regprocedure
          AND ARRAY(SELECT unnest(t.tgattr))=ARRAY[
            (SELECT attnum FROM pg_attribute WHERE attrelid=t.tgrelid AND attname='message_id'),
            (SELECT attnum FROM pg_attribute WHERE attrelid=t.tgrelid AND attname='tenant_id'),
            (SELECT attnum FROM pg_attribute WHERE attrelid=t.tgrelid AND attname='run_id')
          ]::smallint[]
      ) THEN
        DROP TRIGGER IF EXISTS outbox_register_message_id ON ${schema}.outbox;
    CREATE TRIGGER outbox_register_message_id BEFORE INSERT OR UPDATE OF message_id, tenant_id, run_id ON ${schema}.outbox
      FOR EACH ROW EXECUTE FUNCTION ${schema}.outbox_register_message_id();
      END IF;
    END $outbox_trigger$;
  `;
}
