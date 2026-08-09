export const POSTGRES_THREAD_SCHEMA_VERSION = 5;

export function postgresThreadSchemaSql(schema: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
      component text PRIMARY KEY,
      version integer NOT NULL CHECK (version >= 1)
    );
    INSERT INTO ${schema}.schema_migrations(component, version)
      VALUES ('thread_authority', ${POSTGRES_THREAD_SCHEMA_VERSION})
      ON CONFLICT (component) DO NOTHING;

    CREATE TABLE IF NOT EXISTS ${schema}.threads (
      thread_id text PRIMARY KEY,
      tenant_id text NOT NULL,
      space_id text NOT NULL,
      created_by_actor_id text NOT NULL,
      title text,
      revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
      last_event_sequence bigint NOT NULL CHECK (last_event_sequence BETWEEN 1 AND 9007199254740991),
      last_message_sequence bigint NOT NULL CHECK (last_message_sequence BETWEEN 0 AND 9007199254740991),
      status text NOT NULL CHECK (status IN ('active', 'archived', 'deleted')),
      state_json jsonb NOT NULL CHECK (jsonb_typeof(state_json) = 'object'),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      archived_at timestamptz,
      deleted_at timestamptz,
      deleted_by_actor_id text,
      UNIQUE (tenant_id, thread_id)
    );

    CREATE TABLE IF NOT EXISTS ${schema}.thread_events (
      tenant_id text NOT NULL,
      thread_id text NOT NULL,
      sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
      event_id text NOT NULL UNIQUE,
      event_json jsonb NOT NULL CHECK (jsonb_typeof(event_json) = 'object'),
      PRIMARY KEY (thread_id, sequence),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES ${schema}.threads(tenant_id, thread_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ${schema}.messages (
      tenant_id text NOT NULL,
      thread_id text NOT NULL,
      sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
      message_id text NOT NULL UNIQUE,
      role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
      content text NOT NULL,
      content_digest text NOT NULL,
      created_at timestamptz NOT NULL,
      message_json jsonb NOT NULL CHECK (jsonb_typeof(message_json) = 'object'),
      PRIMARY KEY (thread_id, sequence),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES ${schema}.threads(tenant_id, thread_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ${schema}.model_history_items (
      tenant_id text NOT NULL,
      thread_id text NOT NULL,
      sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
      item_id text NOT NULL UNIQUE,
      run_id text,
      segment_id text,
      call_id text,
      tool_kind text CHECK (tool_kind IN ('function', 'custom')),
      item_type text NOT NULL CHECK (item_type IN ('message', 'tool_call', 'tool_result', 'compaction', 'rollback')),
      item_json jsonb NOT NULL CHECK (jsonb_typeof(item_json) = 'object'),
      created_at timestamptz NOT NULL,
      CHECK (
        (item_type IN ('tool_call', 'tool_result') AND run_id IS NOT NULL
          AND segment_id IS NOT NULL AND call_id IS NOT NULL AND tool_kind IS NOT NULL)
        OR
        (item_type IN ('message', 'compaction', 'rollback') AND call_id IS NULL AND tool_kind IS NULL)
      ),
      PRIMARY KEY (thread_id, sequence),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES ${schema}.threads(tenant_id, thread_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ${schema}.message_invalidations (
      tenant_id text NOT NULL,
      thread_id text NOT NULL,
      message_sequence bigint NOT NULL
        CHECK (message_sequence BETWEEN 1 AND 9007199254740991),
      history_sequence bigint NOT NULL
        CHECK (history_sequence BETWEEN 1 AND 9007199254740991),
      rollback_id text NOT NULL,
      marker_item_id text NOT NULL,
      marker_history_sequence bigint NOT NULL
        CHECK (marker_history_sequence BETWEEN 1 AND 9007199254740991),
      invalidated_at timestamptz NOT NULL,
      PRIMARY KEY (thread_id, message_sequence),
      UNIQUE (thread_id, history_sequence),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES ${schema}.threads(tenant_id, thread_id) ON DELETE CASCADE,
      FOREIGN KEY (thread_id, message_sequence)
        REFERENCES ${schema}.messages(thread_id, sequence) ON DELETE CASCADE,
      FOREIGN KEY (thread_id, history_sequence)
        REFERENCES ${schema}.model_history_items(thread_id, sequence) ON DELETE CASCADE,
      FOREIGN KEY (thread_id, marker_history_sequence)
        REFERENCES ${schema}.model_history_items(thread_id, sequence) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ${schema}.thread_rollback_commits (
      tenant_id text NOT NULL,
      thread_id text NOT NULL,
      rollback_id text NOT NULL,
      event_sequence bigint NOT NULL
        CHECK (event_sequence BETWEEN 1 AND 9007199254740991),
      marker_history_sequence bigint NOT NULL
        CHECK (marker_history_sequence BETWEEN 1 AND 9007199254740991),
      invalidated_continuation_count bigint NOT NULL
        CHECK (invalidated_continuation_count BETWEEN 0 AND 9007199254740991),
      invalidated_model_state boolean NOT NULL,
      committed_at timestamptz NOT NULL,
      PRIMARY KEY (thread_id, rollback_id),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES ${schema}.threads(tenant_id, thread_id) ON DELETE CASCADE,
      FOREIGN KEY (thread_id, event_sequence)
        REFERENCES ${schema}.thread_events(thread_id, sequence) ON DELETE CASCADE,
      FOREIGN KEY (thread_id, marker_history_sequence)
        REFERENCES ${schema}.model_history_items(thread_id, sequence) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ${schema}.thread_idempotency_receipts (
      tenant_id text NOT NULL,
      scope text NOT NULL,
      idempotency_key text NOT NULL,
      thread_id text NOT NULL,
      fingerprint text NOT NULL,
      result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
      PRIMARY KEY (scope, idempotency_key),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES ${schema}.threads(tenant_id, thread_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ${schema}.thread_goals (
      tenant_id text NOT NULL,
      thread_id text NOT NULL,
      goal_id text NOT NULL,
      revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
      state_json jsonb NOT NULL CHECK (jsonb_typeof(state_json) = 'object'),
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, thread_id),
      UNIQUE (tenant_id, goal_id),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES ${schema}.threads(tenant_id, thread_id) ON DELETE CASCADE
    );

    UPDATE ${schema}.schema_migrations
      SET version = 2
      WHERE component = 'thread_authority' AND version = 1;

    CREATE TABLE IF NOT EXISTS ${schema}.thread_goal_events (
      tenant_id text NOT NULL,
      thread_id text NOT NULL,
      sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
      event_id text NOT NULL UNIQUE,
      event_type text NOT NULL CHECK (event_type IN ('goal.updated', 'goal.cleared')),
      event_json jsonb NOT NULL CHECK (jsonb_typeof(event_json) = 'object'),
      occurred_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, thread_id, sequence),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES ${schema}.threads(tenant_id, thread_id) ON DELETE CASCADE
    );

    UPDATE ${schema}.schema_migrations
      SET version = 3
      WHERE component = 'thread_authority' AND version = 2;

    DO $thread_lifecycle_v4$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM ${schema}.schema_migrations
        WHERE component = 'thread_authority' AND version = 3
      ) THEN
        ALTER TABLE ${schema}.threads
          ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
        ALTER TABLE ${schema}.threads
          ADD COLUMN IF NOT EXISTS deleted_by_actor_id text;
        ALTER TABLE ${schema}.threads
          DROP CONSTRAINT IF EXISTS threads_status_check;
        ALTER TABLE ${schema}.threads
          ADD CONSTRAINT threads_status_check
          CHECK (status IN ('active', 'archived', 'deleted'));

        UPDATE ${schema}.threads
          SET state_json = state_json ||
            jsonb_build_object('deletedAt', NULL, 'deletedByActorId', NULL)
          WHERE NOT (state_json ? 'deletedAt')
             OR NOT (state_json ? 'deletedByActorId');

        UPDATE ${schema}.thread_idempotency_receipts
          SET result_json = jsonb_set(
            jsonb_set(result_json, '{state,deletedAt}', 'null'::jsonb, true),
            '{state,deletedByActorId}', 'null'::jsonb, true
          )
          WHERE jsonb_typeof(result_json->'state') = 'object'
            AND (
              NOT ((result_json->'state') ? 'deletedAt')
              OR NOT ((result_json->'state') ? 'deletedByActorId')
            );

        UPDATE ${schema}.thread_idempotency_receipts
          SET result_json = jsonb_set(
            jsonb_set(result_json, '{threadState,deletedAt}', 'null'::jsonb, true),
            '{threadState,deletedByActorId}', 'null'::jsonb, true
          )
          WHERE jsonb_typeof(result_json->'threadState') = 'object'
            AND (
              NOT ((result_json->'threadState') ? 'deletedAt')
              OR NOT ((result_json->'threadState') ? 'deletedByActorId')
            );

        UPDATE ${schema}.schema_migrations
          SET version = 4
          WHERE component = 'thread_authority' AND version = 3;
      END IF;
    END
    $thread_lifecycle_v4$;

    DO $thread_rollback_v5$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM ${schema}.schema_migrations
        WHERE component = 'thread_authority' AND version = 4
      ) THEN
        ALTER TABLE ${schema}.model_history_items
          DROP CONSTRAINT IF EXISTS model_history_items_item_type_check;
        ALTER TABLE ${schema}.model_history_items
          DROP CONSTRAINT IF EXISTS model_history_items_check;
        ALTER TABLE ${schema}.model_history_items
          ADD CONSTRAINT model_history_items_item_type_check
          CHECK (item_type IN ('message', 'tool_call', 'tool_result', 'compaction', 'rollback'));
        ALTER TABLE ${schema}.model_history_items
          ADD CONSTRAINT model_history_items_execution_identity_check
          CHECK (
            (item_type IN ('tool_call', 'tool_result') AND run_id IS NOT NULL
              AND segment_id IS NOT NULL AND call_id IS NOT NULL AND tool_kind IS NOT NULL)
            OR
            (item_type IN ('message', 'compaction', 'rollback')
              AND call_id IS NULL AND tool_kind IS NULL)
          );

        UPDATE ${schema}.schema_migrations
          SET version = ${POSTGRES_THREAD_SCHEMA_VERSION}
          WHERE component = 'thread_authority' AND version = 4;
      END IF;
    END
    $thread_rollback_v5$;

    CREATE INDEX IF NOT EXISTS thread_events_tenant_thread_idx
      ON ${schema}.thread_events(tenant_id, thread_id, sequence);
    CREATE INDEX IF NOT EXISTS threads_visible_list_idx
      ON ${schema}.threads(tenant_id, space_id, updated_at DESC, thread_id DESC)
      WHERE status != 'deleted';
    CREATE INDEX IF NOT EXISTS thread_goal_events_tenant_thread_idx
      ON ${schema}.thread_goal_events(tenant_id, thread_id, sequence);
    CREATE INDEX IF NOT EXISTS messages_tenant_thread_idx
      ON ${schema}.messages(tenant_id, thread_id, sequence);
    CREATE INDEX IF NOT EXISTS model_history_tenant_thread_idx
      ON ${schema}.model_history_items(tenant_id, thread_id, sequence);
    CREATE INDEX IF NOT EXISTS message_invalidations_thread_idx
      ON ${schema}.message_invalidations(tenant_id, thread_id, message_sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS model_history_tool_call_key_idx
      ON ${schema}.model_history_items(thread_id, run_id, call_id)
      WHERE item_type = 'tool_call';
    CREATE UNIQUE INDEX IF NOT EXISTS model_history_tool_result_key_idx
      ON ${schema}.model_history_items(thread_id, run_id, call_id)
      WHERE item_type = 'tool_result';`;
}
