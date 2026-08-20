export const POSTGRES_EXECUTION_SCHEMA_VERSION = 6;

export function postgresExecutionSchemaSql(schema: string): string {
  return `
    INSERT INTO ${schema}.schema_migrations(component, version)
      VALUES ('execution_authority', ${POSTGRES_EXECUTION_SCHEMA_VERSION})
      ON CONFLICT (component) DO NOTHING;

    CREATE TABLE IF NOT EXISTS ${schema}.run_steps (
      step_id text NOT NULL,
      tenant_id text NOT NULL,
      run_id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('model','tool','agent','workflowNode','gate','verification')),
      status text NOT NULL CHECK (status IN ('pending','ready','running','waitingApproval','completed','failed','skipped','canceled')),
      revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
      current_attempt_id text,
      attempt_count bigint NOT NULL CHECK (attempt_count BETWEEN 0 AND 9007199254740991),
      state_json jsonb NOT NULL CHECK (jsonb_typeof(state_json) = 'object'),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      terminal_at timestamptz,
      PRIMARY KEY (tenant_id, run_id, step_id),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES ${schema}.run_snapshots(tenant_id, run_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ${schema}.run_attempts (
      attempt_id text PRIMARY KEY,
      tenant_id text NOT NULL,
      run_id text NOT NULL,
      step_id text NOT NULL,
      work_item_id text NOT NULL,
      attempt_number bigint NOT NULL CHECK (attempt_number BETWEEN 1 AND 9007199254740991),
      retry_of_attempt_id text,
      lease_epoch bigint NOT NULL CHECK (lease_epoch BETWEEN 1 AND 9007199254740991),
      status text NOT NULL CHECK (status IN ('running','completed','failed','canceled','abandoned')),
      state_json jsonb NOT NULL CHECK (jsonb_typeof(state_json) = 'object'),
      started_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      terminal_at timestamptz,
      CONSTRAINT run_attempts_run_step_number_key
        UNIQUE (tenant_id, run_id, step_id, attempt_number),
      UNIQUE (tenant_id, run_id, step_id, attempt_id),
      FOREIGN KEY (tenant_id, run_id, step_id)
        REFERENCES ${schema}.run_steps(tenant_id, run_id, step_id) ON DELETE CASCADE,
      FOREIGN KEY (work_item_id)
        REFERENCES ${schema}.work_items(work_item_id) ON DELETE CASCADE,
      FOREIGN KEY (retry_of_attempt_id)
        REFERENCES ${schema}.run_attempts(attempt_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS run_steps_run_idx
      ON ${schema}.run_steps(tenant_id, run_id, status, step_id);

    CREATE TABLE IF NOT EXISTS ${schema}.thread_continuations (
      tenant_id text NOT NULL,
      thread_id text NOT NULL,
      agent_version_id text NOT NULL,
      adapter_name text NOT NULL,
      adapter_version text NOT NULL,
      model_id text NOT NULL,
      through_history_sequence bigint NOT NULL
        CHECK (through_history_sequence BETWEEN 1 AND 9007199254740991),
      context_revision text NOT NULL,
      checkpoint_json jsonb NOT NULL CHECK (jsonb_typeof(checkpoint_json) = 'object'),
      continuation_json jsonb NOT NULL CHECK (jsonb_typeof(continuation_json) = 'object'),
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (
        tenant_id,
        thread_id,
        agent_version_id,
        adapter_name,
        adapter_version,
        model_id
      ),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES ${schema}.threads(tenant_id, thread_id) ON DELETE CASCADE,
      FOREIGN KEY (thread_id, through_history_sequence)
        REFERENCES ${schema}.model_history_items(thread_id, sequence) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS thread_continuations_thread_idx
      ON ${schema}.thread_continuations(
        tenant_id, thread_id, through_history_sequence
      );

    CREATE TABLE IF NOT EXISTS ${schema}.thread_model_states (
      tenant_id text NOT NULL,
      thread_id text NOT NULL,
      state_json jsonb NOT NULL CHECK (jsonb_typeof(state_json) = 'object'),
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, thread_id),
      FOREIGN KEY (tenant_id, thread_id)
        REFERENCES ${schema}.threads(tenant_id, thread_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ${schema}.tool_execution_receipts (
      receipt_id text PRIMARY KEY,
      tenant_id text NOT NULL,
      run_id text NOT NULL,
      step_id text NOT NULL,
      attempt_id text NOT NULL,
      work_item_id text NOT NULL,
      action_digest text NOT NULL,
      idempotency_key text NOT NULL,
      status text NOT NULL
        CHECK (status IN ('prepared','dispatched','unknownOutcome','completed','canceled')),
      revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
      state_json jsonb NOT NULL CHECK (jsonb_typeof(state_json) = 'object'),
      prepared_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      resolved_at timestamptz,
      UNIQUE (tenant_id, run_id, action_digest),
      UNIQUE (tenant_id, idempotency_key),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES ${schema}.run_snapshots(tenant_id, run_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, run_id, step_id, attempt_id)
        REFERENCES ${schema}.run_attempts(tenant_id, run_id, step_id, attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (work_item_id)
        REFERENCES ${schema}.work_items(work_item_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS tool_execution_receipts_run_idx
      ON ${schema}.tool_execution_receipts(tenant_id, run_id, status, receipt_id);
    CREATE INDEX IF NOT EXISTS tool_execution_receipts_attempt_idx
      ON ${schema}.tool_execution_receipts(
        tenant_id, run_id, step_id, attempt_id
      );

    CREATE TABLE IF NOT EXISTS ${schema}.tool_approvals (
      approval_id text PRIMARY KEY,
      tenant_id text NOT NULL,
      space_id text NOT NULL,
      run_id text NOT NULL,
      receipt_id text NOT NULL,
      work_item_id text NOT NULL,
      action_digest text NOT NULL,
      policy_snapshot_id text NOT NULL,
      status text NOT NULL
        CHECK (status IN ('required','approved','rejected','expired','superseded')),
      revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
      state_json jsonb NOT NULL CHECK (jsonb_typeof(state_json) = 'object'),
      required_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (tenant_id, run_id, action_digest),
      FOREIGN KEY (tenant_id, run_id)
        REFERENCES ${schema}.run_snapshots(tenant_id, run_id) ON DELETE CASCADE,
      FOREIGN KEY (receipt_id)
        REFERENCES ${schema}.tool_execution_receipts(receipt_id) ON DELETE RESTRICT,
      FOREIGN KEY (work_item_id)
        REFERENCES ${schema}.work_items(work_item_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS tool_approvals_run_idx
      ON ${schema}.tool_approvals(tenant_id, run_id, status, approval_id);
    CREATE INDEX IF NOT EXISTS tool_approvals_action_idx
      ON ${schema}.tool_approvals(tenant_id, run_id, action_digest);

    DO $migration$
    BEGIN
      ALTER TABLE ${schema}.run_steps ADD CONSTRAINT run_steps_current_attempt_fk
        FOREIGN KEY (tenant_id, run_id, step_id, current_attempt_id)
        REFERENCES ${schema}.run_attempts(tenant_id, run_id, step_id, attempt_id)
        DEFERRABLE INITIALLY DEFERRED;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $migration$;

    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM ${schema}.schema_migrations
        WHERE component = 'execution_authority' AND version BETWEEN 1 AND 5
      ) THEN
        IF to_regclass('${schema}.workflow_gate_requests') IS NOT NULL THEN
          ALTER TABLE ${schema}.workflow_gate_requests DROP CONSTRAINT
            IF EXISTS workflow_gate_requests_tenant_id_run_id_step_id_fkey;
        END IF;
        ALTER TABLE ${schema}.run_attempts DROP CONSTRAINT
          run_attempts_tenant_id_run_id_step_id_fkey;
        ALTER TABLE ${schema}.run_steps DROP CONSTRAINT run_steps_pkey;
        ALTER TABLE ${schema}.run_steps ADD CONSTRAINT run_steps_pkey
          PRIMARY KEY (tenant_id, run_id, step_id);
        ALTER TABLE ${schema}.run_steps DROP CONSTRAINT
          run_steps_tenant_id_run_id_step_id_key;
        ALTER TABLE ${schema}.run_attempts ADD CONSTRAINT
          run_attempts_tenant_id_run_id_step_id_fkey
          FOREIGN KEY (tenant_id, run_id, step_id)
          REFERENCES ${schema}.run_steps(tenant_id, run_id, step_id)
          ON DELETE CASCADE;
        IF to_regclass('${schema}.workflow_gate_requests') IS NOT NULL THEN
          ALTER TABLE ${schema}.workflow_gate_requests ADD CONSTRAINT
            workflow_gate_requests_tenant_id_run_id_step_id_fkey
            FOREIGN KEY (tenant_id, run_id, step_id)
            REFERENCES ${schema}.run_steps(tenant_id, run_id, step_id);
        END IF;
        ALTER TABLE ${schema}.run_attempts
          DROP CONSTRAINT IF EXISTS run_attempts_tenant_id_step_id_attempt_number_key;
        ALTER TABLE ${schema}.run_attempts
          ADD CONSTRAINT run_attempts_run_step_number_key
          UNIQUE (tenant_id, run_id, step_id, attempt_number);
      END IF;
    END $migration$;

    DROP INDEX IF EXISTS ${schema}.run_attempts_step_idx;

    UPDATE ${schema}.schema_migrations
      SET version = ${POSTGRES_EXECUTION_SCHEMA_VERSION}
      WHERE component = 'execution_authority' AND version BETWEEN 1 AND 5;`;
}
