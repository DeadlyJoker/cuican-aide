import {
  RunStoreError,
  validateWorkspaceOperationRecord,
} from "@crewon/application";
import type { PoolClient } from "pg";

import { validateWorkspaceOperationDigestAuthority } from "./workspace-operation-digest-authority.ts";
import { workspaceOperationResultDigest } from "./workspace-operation-store-support.ts";

export const POSTGRES_WORKSPACE_OPERATION_SCHEMA_VERSION = 2;

export async function migratePostgresWorkspaceOperationSchema(
  client: PoolClient,
  schemaSql: string,
  schemaName: string,
): Promise<void> {
  const migration = await client.query<{ version: number }>(
    `SELECT version FROM ${schemaSql}.schema_migrations
     WHERE component = 'workspace_operation_authority'`,
  );
  const version = migration.rows[0]?.version;
  if (
    version !== undefined &&
    version > POSTGRES_WORKSPACE_OPERATION_SCHEMA_VERSION
  ) {
    throw new RunStoreError("postgres_schema_too_new");
  }
  if (version === undefined) {
    await client.query(postgresWorkspaceOperationSchemaSql(schemaSql));
    await client.query(
      `INSERT INTO ${schemaSql}.schema_migrations (component, version)
       VALUES ('workspace_operation_authority', $1)`,
      [POSTGRES_WORKSPACE_OPERATION_SCHEMA_VERSION],
    );
  } else if (version === 1) {
    await migrateVersionOne(client, schemaSql);
    await client.query(
      `UPDATE ${schemaSql}.schema_migrations SET version = $1
       WHERE component = 'workspace_operation_authority' AND version = 1`,
      [POSTGRES_WORKSPACE_OPERATION_SCHEMA_VERSION],
    );
  } else if (version !== POSTGRES_WORKSPACE_OPERATION_SCHEMA_VERSION) {
    throw new RunStoreError("postgres_schema_version_unsupported");
  }
  await assertSchema(client, schemaName);
}

export function postgresWorkspaceOperationSchemaSql(schemaSql: string): string {
  return `
    CREATE TABLE ${schemaSql}.workspace_operations (
      tenant_id TEXT NOT NULL CONSTRAINT workspace_operations_tenant_id_check
        CHECK (length(tenant_id) BETWEEN 1 AND 512),
      space_id TEXT NOT NULL CONSTRAINT workspace_operations_space_id_check
        CHECK (length(space_id) BETWEEN 1 AND 512),
      thread_id TEXT NOT NULL CONSTRAINT workspace_operations_thread_id_check
        CHECK (length(thread_id) BETWEEN 1 AND 512),
      execution_id TEXT NOT NULL CONSTRAINT workspace_operations_execution_id_check
        CHECK (length(execution_id) BETWEEN 1 AND 512),
      base_revision BIGINT NOT NULL CONSTRAINT workspace_operations_base_revision_check
        CHECK (base_revision >= 1),
      revision BIGINT NOT NULL CONSTRAINT workspace_operations_revision_check
        CHECK (revision >= base_revision),
      status TEXT NOT NULL CONSTRAINT workspace_operations_status_check CHECK (
        status IN ('prepared', 'unknownOutcome', 'completed', 'failed', 'canceled')
      ),
      action_digest TEXT NOT NULL CONSTRAINT workspace_operations_action_digest_check
        CHECK (action_digest ~ '^sha256:[0-9a-f]{64}$'),
      command_digest TEXT NOT NULL CONSTRAINT workspace_operations_command_digest_check
        CHECK (command_digest ~ '^sha256:[0-9a-f]{64}$'),
      operation_json JSONB NOT NULL CONSTRAINT workspace_operations_json_check
        CHECK (jsonb_typeof(operation_json) = 'object'),
      CONSTRAINT workspace_operations_pkey PRIMARY KEY (tenant_id, execution_id)
    );

    CREATE INDEX workspace_operations_thread_idx
      ON ${schemaSql}.workspace_operations
      (tenant_id, space_id, thread_id, execution_id);

    ${postgresRevisionAndAttemptTablesSql(schemaSql)}

    CREATE TABLE ${schemaSql}.workspace_operation_receipts (
      tenant_id TEXT NOT NULL CONSTRAINT workspace_operation_receipts_tenant_id_check
        CHECK (length(tenant_id) BETWEEN 1 AND 512),
      space_id TEXT NOT NULL CONSTRAINT workspace_operation_receipts_space_id_check
        CHECK (length(space_id) BETWEEN 1 AND 512),
      phase TEXT NOT NULL CONSTRAINT workspace_operation_receipts_phase_check
        CHECK (phase IN ('execute', 'reconcile', 'cancel')),
      scope TEXT NOT NULL CONSTRAINT workspace_operation_receipts_scope_check
        CHECK (length(scope) BETWEEN 1 AND 512),
      idempotency_key TEXT NOT NULL CONSTRAINT workspace_operation_receipts_key_check
        CHECK (length(idempotency_key) BETWEEN 1 AND 256),
      thread_id TEXT NOT NULL CONSTRAINT workspace_operation_receipts_thread_id_check
        CHECK (length(thread_id) BETWEEN 1 AND 512),
      execution_id TEXT NOT NULL CONSTRAINT workspace_operation_receipts_execution_id_check
        CHECK (length(execution_id) BETWEEN 1 AND 512),
      action_digest TEXT NOT NULL CONSTRAINT workspace_operation_receipts_action_digest_check
        CHECK (action_digest ~ '^sha256:[0-9a-f]{64}$'),
      command_digest TEXT NOT NULL CONSTRAINT workspace_operation_receipts_command_digest_check
        CHECK (command_digest ~ '^sha256:[0-9a-f]{64}$'),
      fingerprint TEXT NOT NULL CONSTRAINT workspace_operation_receipts_fingerprint_check
        CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
      attempt_number BIGINT,
      attempt_identity TEXT,
      seed_result_revision BIGINT NOT NULL CHECK (seed_result_revision >= 1),
      seed_result_digest TEXT NOT NULL CHECK (seed_result_digest ~ '^sha256:[0-9a-f]{64}$'),
      CONSTRAINT workspace_operation_receipts_pkey
        PRIMARY KEY (tenant_id, space_id, phase, scope, idempotency_key),
      CONSTRAINT workspace_operation_receipts_operation_fkey
        FOREIGN KEY (tenant_id, execution_id)
        REFERENCES ${schemaSql}.workspace_operations(tenant_id, execution_id)
        ON DELETE RESTRICT,
      CONSTRAINT workspace_operation_receipts_attempt_fkey
        FOREIGN KEY (tenant_id, execution_id, attempt_number)
        REFERENCES ${schemaSql}.workspace_delivery_attempts(
          tenant_id, execution_id, attempt_number
        ) ON DELETE RESTRICT,
      CONSTRAINT workspace_operation_receipts_result_fkey
        FOREIGN KEY (
          tenant_id, execution_id, seed_result_revision, seed_result_digest
        ) REFERENCES ${schemaSql}.workspace_operation_revisions(
          tenant_id, execution_id, revision, result_digest
        ) ON DELETE RESTRICT,
      CONSTRAINT workspace_operation_receipts_attempt_identity_check
        CHECK ((attempt_number IS NULL) = (attempt_identity IS NULL))
    );
  `;
}

function postgresRevisionAndAttemptTablesSql(schemaSql: string): string {
  return `
    CREATE TABLE ${schemaSql}.workspace_operation_revisions (
      tenant_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      revision BIGINT NOT NULL CHECK (revision >= 1),
      result_digest TEXT NOT NULL CHECK (result_digest ~ '^sha256:[0-9a-f]{64}$'),
      operation_json JSONB NOT NULL CHECK (jsonb_typeof(operation_json) = 'object'),
      CONSTRAINT workspace_operation_revisions_pkey
        PRIMARY KEY (tenant_id, execution_id, revision),
      CONSTRAINT workspace_operation_revisions_result_key
        UNIQUE (tenant_id, execution_id, revision, result_digest),
      CONSTRAINT workspace_operation_revisions_operation_fkey
        FOREIGN KEY (tenant_id, execution_id)
        REFERENCES ${schemaSql}.workspace_operations(tenant_id, execution_id)
        ON DELETE RESTRICT
    );

    CREATE TABLE ${schemaSql}.workspace_delivery_attempts (
      tenant_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      attempt_number BIGINT NOT NULL CHECK (attempt_number >= 1),
      operation_revision BIGINT NOT NULL CHECK (operation_revision >= 1),
      phase TEXT NOT NULL CHECK (phase IN ('execute', 'reconcile', 'cancel')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'settled')),
      action_digest TEXT NOT NULL CHECK (action_digest ~ '^sha256:[0-9a-f]{64}$'),
      command_digest TEXT NOT NULL CHECK (command_digest ~ '^sha256:[0-9a-f]{64}$'),
      created_at TIMESTAMPTZ NOT NULL,
      lease_owner_id TEXT,
      lease_id TEXT,
      lease_epoch BIGINT CHECK (lease_epoch >= 1),
      leased_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      settlement_kind TEXT CHECK (
        settlement_kind IN ('resolution', 'superseded', 'leaseExpired', 'abandoned')
      ),
      resolution_status TEXT CHECK (
        resolution_status IN ('completed', 'failed', 'canceled', 'unknownOutcome')
      ),
      settled_at TIMESTAMPTZ,
      result_revision BIGINT CHECK (result_revision >= 1),
      result_digest TEXT CHECK (
        result_digest IS NULL OR result_digest ~ '^sha256:[0-9a-f]{64}$'
      ),
      attempt_json JSONB NOT NULL CHECK (jsonb_typeof(attempt_json) = 'object'),
      CONSTRAINT workspace_delivery_attempts_pkey
        PRIMARY KEY (tenant_id, execution_id, attempt_number),
      CONSTRAINT workspace_delivery_attempts_operation_revision_fkey
        FOREIGN KEY (tenant_id, execution_id, operation_revision)
        REFERENCES ${schemaSql}.workspace_operation_revisions(
          tenant_id, execution_id, revision
        ) ON DELETE RESTRICT,
      CONSTRAINT workspace_delivery_attempts_result_fkey
        FOREIGN KEY (tenant_id, execution_id, result_revision, result_digest)
        REFERENCES ${schemaSql}.workspace_operation_revisions(
          tenant_id, execution_id, revision, result_digest
        ) ON DELETE RESTRICT,
      CONSTRAINT workspace_delivery_attempts_state_check CHECK (
        (status = 'pending'
          AND lease_owner_id IS NULL AND lease_id IS NULL AND lease_epoch IS NULL
          AND leased_at IS NULL AND expires_at IS NULL
          AND settlement_kind IS NULL AND resolution_status IS NULL
          AND settled_at IS NULL AND result_revision IS NULL AND result_digest IS NULL)
        OR (status = 'leased'
          AND lease_owner_id IS NOT NULL AND lease_id IS NOT NULL AND lease_epoch IS NOT NULL
          AND leased_at IS NOT NULL AND expires_at IS NOT NULL
          AND settlement_kind IS NULL AND resolution_status IS NULL
          AND settled_at IS NULL AND result_revision IS NULL AND result_digest IS NULL)
        OR (status = 'settled'
          AND settlement_kind IS NOT NULL AND settled_at IS NOT NULL
          AND result_revision IS NOT NULL AND result_digest IS NOT NULL
          AND ((settlement_kind = 'superseded'
              AND lease_owner_id IS NULL AND lease_id IS NULL AND lease_epoch IS NULL
              AND leased_at IS NULL AND expires_at IS NULL)
            OR (lease_owner_id IS NOT NULL AND lease_id IS NOT NULL
              AND lease_epoch IS NOT NULL AND leased_at IS NOT NULL AND expires_at IS NOT NULL)))
      ),
      CONSTRAINT workspace_delivery_attempts_resolution_check
        CHECK ((settlement_kind = 'resolution') = (resolution_status IS NOT NULL))
    );

    CREATE INDEX workspace_delivery_attempts_claim_idx
      ON ${schemaSql}.workspace_delivery_attempts
      (tenant_id, space_id, status, execution_id, attempt_number);
  `;
}

async function migrateVersionOne(
  client: PoolClient,
  schemaSql: string,
): Promise<void> {
  await client.query(`
    ALTER TABLE ${schemaSql}.workspace_operations
      ADD COLUMN base_revision BIGINT;
    UPDATE ${schemaSql}.workspace_operations SET base_revision = revision;
    ALTER TABLE ${schemaSql}.workspace_operations
      ALTER COLUMN base_revision SET NOT NULL;
    ALTER TABLE ${schemaSql}.workspace_operations
      ADD CONSTRAINT workspace_operations_base_revision_check
      CHECK (base_revision >= 1);
    ALTER TABLE ${schemaSql}.workspace_operations
      DROP CONSTRAINT workspace_operations_revision_check;
    ALTER TABLE ${schemaSql}.workspace_operations
      ADD CONSTRAINT workspace_operations_revision_check
      CHECK (revision >= base_revision);

    ${postgresRevisionAndAttemptTablesSql(schemaSql)}

    ALTER TABLE ${schemaSql}.workspace_operation_receipts
      ADD COLUMN attempt_number BIGINT,
      ADD COLUMN attempt_identity TEXT,
      ADD COLUMN seed_result_revision BIGINT,
      ADD COLUMN seed_result_digest TEXT;
  `);
  let tenantId = "";
  let executionId = "";
  for (;;) {
    const page = await client.query<{
      tenant_id: string;
      execution_id: string;
      revision: string | number;
      operation_json: unknown;
    }>(
      `SELECT tenant_id, execution_id, revision, operation_json
       FROM ${schemaSql}.workspace_operations
       WHERE (tenant_id, execution_id) > ($1, $2)
       ORDER BY tenant_id, execution_id
       LIMIT 500`,
      [tenantId, executionId],
    );
    if (page.rows.length === 0) break;
    for (const row of page.rows) {
      const operation = validateWorkspaceOperationDigestAuthority(
        validateWorkspaceOperationRecord(row.operation_json),
      );
      if (
        operation.tenantId !== row.tenant_id ||
        operation.executionId !== row.execution_id ||
        operation.revision !== safeInteger(row.revision)
      ) {
        throw new RunStoreError("postgres_schema_version_unsupported");
      }
      await client.query(
        `INSERT INTO ${schemaSql}.workspace_operation_revisions (
           tenant_id, execution_id, revision, result_digest, operation_json
         ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          operation.tenantId,
          operation.executionId,
          operation.revision,
          workspaceOperationResultDigest(operation),
          JSON.stringify(operation),
        ],
      );
    }
    tenantId = page.rows.at(-1)!.tenant_id;
    executionId = page.rows.at(-1)!.execution_id;
  }
  await client.query(`
    UPDATE ${schemaSql}.workspace_operation_receipts AS receipts
    SET seed_result_revision = revisions.revision,
        seed_result_digest = revisions.result_digest
    FROM ${schemaSql}.workspace_operation_revisions AS revisions
    WHERE revisions.tenant_id = receipts.tenant_id
      AND revisions.execution_id = receipts.execution_id;

    ALTER TABLE ${schemaSql}.workspace_operation_receipts
      ALTER COLUMN seed_result_revision SET NOT NULL,
      ALTER COLUMN seed_result_digest SET NOT NULL,
      ADD CONSTRAINT workspace_operation_receipts_seed_revision_check
        CHECK (seed_result_revision >= 1),
      ADD CONSTRAINT workspace_operation_receipts_seed_digest_check
        CHECK (seed_result_digest ~ '^sha256:[0-9a-f]{64}$'),
      ADD CONSTRAINT workspace_operation_receipts_attempt_identity_check
        CHECK ((attempt_number IS NULL) = (attempt_identity IS NULL)),
      ADD CONSTRAINT workspace_operation_receipts_attempt_fkey
        FOREIGN KEY (tenant_id, execution_id, attempt_number)
        REFERENCES ${schemaSql}.workspace_delivery_attempts(
          tenant_id, execution_id, attempt_number
        ) ON DELETE RESTRICT,
      ADD CONSTRAINT workspace_operation_receipts_result_fkey
        FOREIGN KEY (
          tenant_id, execution_id, seed_result_revision, seed_result_digest
        ) REFERENCES ${schemaSql}.workspace_operation_revisions(
          tenant_id, execution_id, revision, result_digest
        ) ON DELETE RESTRICT;
  `);
}

import {
  assertSchema,
  safeInteger,
} from "./postgres-workspace-operation-schema-validation.ts";
