import type { DatabaseSync } from "node:sqlite";

import {
  RunStoreError,
  validateWorkspaceOperationRecord,
} from "@crewon/application";
import { validateWorkspaceOperationDigestAuthority } from "./workspace-operation-digest-authority.ts";
import { workspaceOperationResultDigest } from "./workspace-operation-store-support.ts";

const TABLES = [
  "workspace_delivery_attempts",
  "workspace_operation_receipts",
  "workspace_operation_revisions",
  "workspace_operations",
] as const;

export function sqliteWorkspaceOperationTablesSql(): string {
  return `
    CREATE TABLE workspace_operations (
      tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 512),
      space_id TEXT NOT NULL CHECK (length(space_id) BETWEEN 1 AND 512),
      thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 512),
      execution_id TEXT NOT NULL CHECK (length(execution_id) BETWEEN 1 AND 512),
      base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
      revision INTEGER NOT NULL CHECK (revision >= base_revision),
      status TEXT NOT NULL CHECK (
        status IN ('prepared', 'unknownOutcome', 'completed', 'failed', 'canceled')
      ),
      action_digest TEXT NOT NULL ${digestCheck("action_digest")},
      command_digest TEXT NOT NULL ${digestCheck("command_digest")},
      operation_json TEXT NOT NULL CHECK (json_valid(operation_json)),
      PRIMARY KEY (tenant_id, execution_id)
    ) STRICT;

    CREATE INDEX workspace_operations_thread_idx
      ON workspace_operations (tenant_id, space_id, thread_id, execution_id);

    CREATE TABLE workspace_operation_revisions (
      tenant_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      result_digest TEXT NOT NULL ${digestCheck("result_digest")},
      operation_json TEXT NOT NULL CHECK (json_valid(operation_json)),
      PRIMARY KEY (tenant_id, execution_id, revision),
      UNIQUE (tenant_id, execution_id, revision, result_digest),
      FOREIGN KEY (tenant_id, execution_id)
        REFERENCES workspace_operations(tenant_id, execution_id)
        ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE workspace_delivery_attempts (
      tenant_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
      operation_revision INTEGER NOT NULL CHECK (operation_revision >= 1),
      phase TEXT NOT NULL CHECK (phase IN ('execute', 'reconcile', 'cancel')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'settled')),
      action_digest TEXT NOT NULL ${digestCheck("action_digest")},
      command_digest TEXT NOT NULL ${digestCheck("command_digest")},
      created_at TEXT NOT NULL,
      lease_owner_id TEXT,
      lease_id TEXT,
      lease_epoch INTEGER CHECK (lease_epoch >= 1),
      leased_at TEXT,
      expires_at TEXT,
      settlement_kind TEXT CHECK (
        settlement_kind IN ('resolution', 'superseded', 'leaseExpired', 'abandoned')
      ),
      resolution_status TEXT CHECK (
        resolution_status IN ('completed', 'failed', 'canceled', 'unknownOutcome')
      ),
      settled_at TEXT,
      result_revision INTEGER CHECK (result_revision >= 1),
      result_digest TEXT ${digestCheck("result_digest")},
      attempt_json TEXT NOT NULL CHECK (json_valid(attempt_json)),
      PRIMARY KEY (tenant_id, execution_id, attempt_number),
      FOREIGN KEY (tenant_id, execution_id, operation_revision)
        REFERENCES workspace_operation_revisions(tenant_id, execution_id, revision)
        ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, execution_id, result_revision, result_digest)
        REFERENCES workspace_operation_revisions(
          tenant_id, execution_id, revision, result_digest
        ) ON DELETE RESTRICT,
      CHECK (
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
              AND lease_owner_id IS NULL AND lease_id IS NULL
              AND lease_epoch IS NULL AND leased_at IS NULL AND expires_at IS NULL)
            OR (lease_owner_id IS NOT NULL AND lease_id IS NOT NULL
              AND lease_epoch IS NOT NULL AND leased_at IS NOT NULL AND expires_at IS NOT NULL)))
      ),
      CHECK ((settlement_kind = 'resolution') = (resolution_status IS NOT NULL))
    ) STRICT;

    CREATE INDEX workspace_delivery_attempts_claim_idx
      ON workspace_delivery_attempts
      (tenant_id, space_id, status, execution_id, attempt_number);

    CREATE TABLE workspace_operation_receipts (
      tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 512),
      space_id TEXT NOT NULL CHECK (length(space_id) BETWEEN 1 AND 512),
      phase TEXT NOT NULL CHECK (phase IN ('execute', 'reconcile', 'cancel')),
      scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 512),
      idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
      thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 512),
      execution_id TEXT NOT NULL CHECK (length(execution_id) BETWEEN 1 AND 512),
      action_digest TEXT NOT NULL ${digestCheck("action_digest")},
      command_digest TEXT NOT NULL ${digestCheck("command_digest")},
      fingerprint TEXT NOT NULL ${digestCheck("fingerprint")},
      attempt_number INTEGER,
      attempt_identity TEXT,
      seed_result_revision INTEGER NOT NULL CHECK (seed_result_revision >= 1),
      seed_result_digest TEXT NOT NULL ${digestCheck("seed_result_digest")},
      PRIMARY KEY (tenant_id, space_id, phase, scope, idempotency_key),
      FOREIGN KEY (tenant_id, execution_id)
        REFERENCES workspace_operations(tenant_id, execution_id)
        ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, execution_id, attempt_number)
        REFERENCES workspace_delivery_attempts(tenant_id, execution_id, attempt_number)
        ON DELETE RESTRICT,
      FOREIGN KEY (
        tenant_id, execution_id, seed_result_revision, seed_result_digest
      ) REFERENCES workspace_operation_revisions(
        tenant_id, execution_id, revision, result_digest
      ) ON DELETE RESTRICT,
      CHECK ((attempt_number IS NULL) = (attempt_identity IS NULL))
    ) STRICT;
  `;
}

export function migrateSqliteWorkspaceOperationAuthority(
  database: DatabaseSync,
): void {
  const existing = database
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name LIKE 'workspace_%'
       ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name))
    .filter((name): name is (typeof TABLES)[number] =>
      TABLES.includes(name as (typeof TABLES)[number]),
    );
  if (existing.length === 0) {
    database.exec(sqliteWorkspaceOperationTablesSql());
    return;
  }
  if (
    existing.length === TABLES.length &&
    TABLES.every((table) => existing.includes(table))
  ) {
    assertCurrentSchema(database);
    return;
  }
  if (
    existing.length === 2 &&
    existing.includes("workspace_operations") &&
    existing.includes("workspace_operation_receipts")
  ) {
    migrateVersionOne(database);
    assertCurrentSchema(database);
    return;
  }
  throw new RunStoreError("sqlite_schema_version_unsupported");
}

function migrateVersionOne(database: DatabaseSync): void {
  database.function(
    "crewon_workspace_result_digest_v23",
    { deterministic: true },
    (json) => {
      if (typeof json !== "string") {
        throw new RunStoreError("sqlite_schema_version_unsupported");
      }
      const operation = validateWorkspaceOperationDigestAuthority(
        validateWorkspaceOperationRecord(JSON.parse(json)),
      );
      return workspaceOperationResultDigest(operation);
    },
  );
  database.exec(`
    ALTER TABLE workspace_operation_receipts
      RENAME TO workspace_operation_receipts_v22;
    DROP INDEX workspace_operations_thread_idx;
    ALTER TABLE workspace_operations RENAME TO workspace_operations_v22;

    ${sqliteWorkspaceOperationTablesSql()}

    INSERT INTO workspace_operations (
      tenant_id, space_id, thread_id, execution_id, base_revision, revision,
      status, action_digest, command_digest, operation_json
    )
    SELECT tenant_id, space_id, thread_id, execution_id, revision, revision,
           status, action_digest, command_digest, operation_json
    FROM workspace_operations_v22;

    INSERT INTO workspace_operation_revisions (
      tenant_id, execution_id, revision, result_digest, operation_json
    )
    SELECT tenant_id, execution_id, revision,
           crewon_workspace_result_digest_v23(operation_json), operation_json
    FROM workspace_operations_v22;

    INSERT INTO workspace_operation_receipts (
      tenant_id, space_id, phase, scope, idempotency_key, thread_id,
      execution_id, action_digest, command_digest, fingerprint,
      attempt_number, attempt_identity, seed_result_revision, seed_result_digest
    )
    SELECT receipts.tenant_id, receipts.space_id, receipts.phase, receipts.scope,
           receipts.idempotency_key, receipts.thread_id, receipts.execution_id,
           receipts.action_digest, receipts.command_digest, receipts.fingerprint,
           NULL, NULL, operations.revision,
           crewon_workspace_result_digest_v23(operations.operation_json)
    FROM workspace_operation_receipts_v22 AS receipts
    JOIN workspace_operations_v22 AS operations
      ON operations.tenant_id = receipts.tenant_id
     AND operations.execution_id = receipts.execution_id;

    DROP TABLE workspace_operation_receipts_v22;
    DROP TABLE workspace_operations_v22;
  `);
  if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) {
    throw new RunStoreError("sqlite_foreign_key_migration_invalid");
  }
}

function assertCurrentSchema(database: DatabaseSync): void {
  const expected = new Map<string, readonly string[]>([
    [
      "workspace_operations",
      [
        "tenant_id",
        "space_id",
        "thread_id",
        "execution_id",
        "base_revision",
        "revision",
        "status",
        "action_digest",
        "command_digest",
        "operation_json",
      ],
    ],
    [
      "workspace_operation_revisions",
      [
        "tenant_id",
        "execution_id",
        "revision",
        "result_digest",
        "operation_json",
      ],
    ],
    [
      "workspace_delivery_attempts",
      [
        "tenant_id",
        "space_id",
        "thread_id",
        "execution_id",
        "attempt_number",
        "operation_revision",
        "phase",
        "status",
        "action_digest",
        "command_digest",
        "created_at",
        "lease_owner_id",
        "lease_id",
        "lease_epoch",
        "leased_at",
        "expires_at",
        "settlement_kind",
        "resolution_status",
        "settled_at",
        "result_revision",
        "result_digest",
        "attempt_json",
      ],
    ],
    [
      "workspace_operation_receipts",
      [
        "tenant_id",
        "space_id",
        "phase",
        "scope",
        "idempotency_key",
        "thread_id",
        "execution_id",
        "action_digest",
        "command_digest",
        "fingerprint",
        "attempt_number",
        "attempt_identity",
        "seed_result_revision",
        "seed_result_digest",
      ],
    ],
  ]);
  for (const [table, columns] of expected) {
    const sql = database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) as { sql: string } | undefined;
    const actual = database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name));
    if (
      sql === undefined ||
      !/\)\s*STRICT\s*$/iu.test(sql.sql) ||
      JSON.stringify(actual) !== JSON.stringify(columns) ||
      (table === "workspace_delivery_attempts" &&
        (!sql.sql.includes("status = 'pending'") ||
          !sql.sql.includes("status = 'leased'") ||
          !sql.sql.includes("status = 'settled'") ||
          !sql.sql.includes("lease_owner_id IS NULL AND lease_id IS NULL") ||
          !sql.sql.includes(
            "result_revision IS NOT NULL AND result_digest IS NOT NULL",
          )))
    ) {
      throw new RunStoreError("sqlite_schema_version_unsupported");
    }
  }
  requirePrimaryKey(database, "workspace_operations", [
    "tenant_id",
    "execution_id",
  ]);
  requirePrimaryKey(database, "workspace_operation_revisions", [
    "tenant_id",
    "execution_id",
    "revision",
  ]);
  requireUniqueIndex(database, "workspace_operation_revisions", [
    "tenant_id",
    "execution_id",
    "revision",
    "result_digest",
  ]);
  requirePrimaryKey(database, "workspace_delivery_attempts", [
    "tenant_id",
    "execution_id",
    "attempt_number",
  ]);
  requirePrimaryKey(database, "workspace_operation_receipts", [
    "tenant_id",
    "space_id",
    "phase",
    "scope",
    "idempotency_key",
  ]);
  requireForeignKeys(database, "workspace_operation_revisions", [
    "workspace_operations|tenant_id>tenant_id,execution_id>execution_id|RESTRICT",
  ]);
  requireForeignKeys(database, "workspace_delivery_attempts", [
    "workspace_operation_revisions|tenant_id>tenant_id,execution_id>execution_id,operation_revision>revision|RESTRICT",
    "workspace_operation_revisions|tenant_id>tenant_id,execution_id>execution_id,result_revision>revision,result_digest>result_digest|RESTRICT",
  ]);
  requireForeignKeys(database, "workspace_operation_receipts", [
    "workspace_delivery_attempts|tenant_id>tenant_id,execution_id>execution_id,attempt_number>attempt_number|RESTRICT",
    "workspace_operation_revisions|tenant_id>tenant_id,execution_id>execution_id,seed_result_revision>revision,seed_result_digest>result_digest|RESTRICT",
    "workspace_operations|tenant_id>tenant_id,execution_id>execution_id|RESTRICT",
  ]);
  requireIndex(database, "workspace_delivery_attempts_claim_idx", [
    "tenant_id",
    "space_id",
    "status",
    "execution_id",
    "attempt_number",
  ]);
}

function requirePrimaryKey(
  database: DatabaseSync,
  table: string,
  expected: readonly string[],
): void {
  const actual = database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .filter((row) => Number(row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((row) => String(row.name));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new RunStoreError("sqlite_schema_version_unsupported");
  }
}

function requireUniqueIndex(
  database: DatabaseSync,
  table: string,
  expected: readonly string[],
): void {
  const indices = database
    .prepare(`PRAGMA index_list(${table})`)
    .all()
    .filter((row) => Number(row.unique) === 1);
  if (
    !indices.some(
      (index) =>
        JSON.stringify(indexColumns(database, String(index.name))) ===
        JSON.stringify(expected),
    )
  ) {
    throw new RunStoreError("sqlite_schema_version_unsupported");
  }
}

function requireIndex(
  database: DatabaseSync,
  name: string,
  expected: readonly string[],
): void {
  const exists = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name);
  if (
    exists === undefined ||
    JSON.stringify(indexColumns(database, name)) !== JSON.stringify(expected)
  ) {
    throw new RunStoreError("sqlite_schema_version_unsupported");
  }
}

function indexColumns(database: DatabaseSync, name: string): string[] {
  return database
    .prepare(`PRAGMA index_info(${name})`)
    .all()
    .sort((left, right) => Number(left.seqno) - Number(right.seqno))
    .map((row) => String(row.name));
}

function requireForeignKeys(
  database: DatabaseSync,
  table: string,
  expected: readonly string[],
): void {
  const groups = new Map<number, Array<Record<string, unknown>>>();
  for (const row of database
    .prepare(`PRAGMA foreign_key_list(${table})`)
    .all() as Array<Record<string, unknown>>) {
    const id = Number(row.id);
    groups.set(id, [...(groups.get(id) ?? []), row]);
  }
  const actual = [...groups.values()]
    .map((rows) => {
      rows.sort((left, right) => Number(left.seq) - Number(right.seq));
      return `${String(rows[0]!.table)}|${rows
        .map((row) => `${String(row.from)}>${String(row.to)}`)
        .join(",")}|${String(rows[0]!.on_delete)}`;
    })
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new RunStoreError("sqlite_schema_version_unsupported");
  }
}

function digestCheck(column: string): string {
  return `CHECK (
    length(${column}) = 71
    AND substr(${column}, 1, 7) = 'sha256:'
    AND substr(${column}, 8) NOT GLOB '*[^0-9a-f]*'
  )`;
}
