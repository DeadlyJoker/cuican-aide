import { DatabaseSync } from "node:sqlite";

import { DeviceGatewayError } from "./device-gateway-error.ts";

const SCHEMA_VERSION = 3;

export function configureSqliteDeviceGatewayDatabase(
  database: DatabaseSync,
  path: string,
): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
  }
  const version = Number(
    (database.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );
  if (version > SCHEMA_VERSION) {
    throw new DeviceGatewayError("device_dispatch_schema_newer");
  }
  if (version === 0) migrateEmptyDatabase(database);
  if (version === 1) migrateVersionOne(database);
  if (version === 2) migrateVersionTwo(database);
  assertSqliteDeviceGatewaySchema(database);
}

function migrateEmptyDatabase(database: DatabaseSync): void {
  transaction(database, () => {
    database.exec(`
      ${executionKindsSql()}
      ${toolRecordsSql()}
      ${workspaceAndRouteTablesSql()}
      ${workspaceReadTableSql()}
      PRAGMA user_version = 3;
    `);
  });
}

function migrateVersionOne(database: DatabaseSync): void {
  transaction(database, () => {
    database.exec(`
      ${executionKindsSql()}
      INSERT INTO device_execution_kinds (execution_id, command_kind)
      SELECT execution_id, 'tool' FROM device_dispatch_records;
      CREATE TABLE device_dispatch_records_v2 (
        execution_id TEXT PRIMARY KEY NOT NULL,
        command_kind TEXT NOT NULL DEFAULT 'tool' CHECK (command_kind = 'tool'),
        fingerprint TEXT NOT NULL CHECK (
          length(fingerprint) = 71 AND fingerprint GLOB 'sha256:[0-9a-f]*'
        ),
        command_json TEXT NOT NULL CHECK (json_valid(command_json)),
        resolution_json TEXT CHECK (
          resolution_json IS NULL OR json_valid(resolution_json)
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (execution_id, command_kind)
          REFERENCES device_execution_kinds(execution_id, command_kind)
          ON DELETE RESTRICT
      ) STRICT;
      INSERT INTO device_dispatch_records_v2 (
        execution_id, fingerprint, command_json, resolution_json,
        created_at, updated_at
      ) SELECT execution_id, fingerprint, command_json, resolution_json,
               created_at, updated_at
          FROM device_dispatch_records;
      DROP TABLE device_dispatch_records;
      ALTER TABLE device_dispatch_records_v2 RENAME TO device_dispatch_records;
      ${workspaceAndRouteTablesSql()}
      ${workspaceReadTableSql()}
      PRAGMA user_version = 3;
    `);
  });
}

function executionKindsSql(): string {
  return `
    CREATE TABLE device_execution_kinds (
      execution_id TEXT PRIMARY KEY NOT NULL,
      command_kind TEXT NOT NULL CHECK (
        command_kind IN ('tool', 'workspaceList', 'workspaceRead')
      ),
      UNIQUE (execution_id, command_kind)
    ) STRICT;
  `;
}

function migrateVersionTwo(database: DatabaseSync): void {
  database.exec("PRAGMA legacy_alter_table = ON");
  transaction(database, () => {
    database.exec(`
      ALTER TABLE device_execution_kinds RENAME TO device_execution_kinds_v2;
      ${executionKindsSql()}
      INSERT INTO device_execution_kinds SELECT * FROM device_execution_kinds_v2;
      DROP TABLE device_execution_kinds_v2;
      ${workspaceReadTableSql()}
      PRAGMA user_version = 3;
    `);
  });
  database.exec("PRAGMA legacy_alter_table = OFF");
}

function workspaceReadTableSql(): string {
  return `
    CREATE TABLE workspace_read_dispatch_records (
      execution_id TEXT PRIMARY KEY NOT NULL,
      command_kind TEXT NOT NULL DEFAULT 'workspaceRead' CHECK (command_kind = 'workspaceRead'),
      record_json TEXT NOT NULL CHECK (json_valid(record_json)),
      FOREIGN KEY (execution_id, command_kind)
        REFERENCES device_execution_kinds(execution_id, command_kind)
        ON DELETE RESTRICT
    ) STRICT;
  `;
}

function toolRecordsSql(): string {
  return `
    CREATE TABLE device_dispatch_records (
      execution_id TEXT PRIMARY KEY NOT NULL,
      command_kind TEXT NOT NULL DEFAULT 'tool' CHECK (command_kind = 'tool'),
      fingerprint TEXT NOT NULL CHECK (
        length(fingerprint) = 71 AND fingerprint GLOB 'sha256:[0-9a-f]*'
      ),
      command_json TEXT NOT NULL CHECK (json_valid(command_json)),
      resolution_json TEXT CHECK (
        resolution_json IS NULL OR json_valid(resolution_json)
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (execution_id, command_kind)
        REFERENCES device_execution_kinds(execution_id, command_kind)
        ON DELETE RESTRICT
    ) STRICT;
  `;
}

function workspaceAndRouteTablesSql(): string {
  return `
    CREATE TABLE workspace_dispatch_records (
      execution_id TEXT PRIMARY KEY NOT NULL,
      command_kind TEXT NOT NULL DEFAULT 'workspaceList' CHECK (
        command_kind = 'workspaceList'
      ),
      record_json TEXT NOT NULL CHECK (json_valid(record_json)),
      FOREIGN KEY (execution_id, command_kind)
        REFERENCES device_execution_kinds(execution_id, command_kind)
        ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE device_connection_routes (
      device_id TEXT PRIMARY KEY NOT NULL,
      gateway_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      epoch INTEGER NOT NULL CHECK (epoch > 0),
      lease_expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX device_connection_routes_gateway_idx
      ON device_connection_routes (gateway_id, lease_expires_at);
  `;
}

function assertSqliteDeviceGatewaySchema(database: DatabaseSync): void {
  requireStrictTable(database, "device_execution_kinds", [
    column("execution_id", "TEXT", 1, null, 1),
    column("command_kind", "TEXT", 1, null, 0),
  ]);
  requireUniqueColumns(database, "device_execution_kinds", [
    "execution_id",
    "command_kind",
  ]);
  requireTableSql(database, "device_execution_kinds", [
    "command_kind IN ('tool', 'workspaceList', 'workspaceRead')",
  ]);
  requireStrictTable(database, "device_dispatch_records", [
    column("execution_id", "TEXT", 1, null, 1),
    column("command_kind", "TEXT", 1, "'tool'", 0),
    column("fingerprint", "TEXT", 1, null, 0),
    column("command_json", "TEXT", 1, null, 0),
    column("resolution_json", "TEXT", 0, null, 0),
    column("created_at", "TEXT", 1, null, 0),
    column("updated_at", "TEXT", 1, null, 0),
  ]);
  requireCompositeKindForeignKey(database, "device_dispatch_records");
  requireTableSql(database, "device_dispatch_records", [
    "CHECK (command_kind = 'tool')",
    "CHECK (json_valid(command_json))",
    "CHECK ( resolution_json IS NULL OR json_valid(resolution_json) )",
    "length(fingerprint) = 71",
  ]);
  requireStrictTable(database, "workspace_dispatch_records", [
    column("execution_id", "TEXT", 1, null, 1),
    column("command_kind", "TEXT", 1, "'workspaceList'", 0),
    column("record_json", "TEXT", 1, null, 0),
  ]);
  requireCompositeKindForeignKey(database, "workspace_dispatch_records");
  requireTableSql(database, "workspace_dispatch_records", [
    "CHECK ( command_kind = 'workspaceList' )",
    "CHECK (json_valid(record_json))",
  ]);
  requireStrictTable(database, "workspace_read_dispatch_records", [
    column("execution_id", "TEXT", 1, null, 1),
    column("command_kind", "TEXT", 1, "'workspaceRead'", 0),
    column("record_json", "TEXT", 1, null, 0),
  ]);
  requireCompositeKindForeignKey(database, "workspace_read_dispatch_records");
  requireStrictTable(database, "device_connection_routes", [
    column("device_id", "TEXT", 1, null, 1),
    column("gateway_id", "TEXT", 1, null, 0),
    column("connection_id", "TEXT", 1, null, 0),
    column("epoch", "INTEGER", 1, null, 0),
    column("lease_expires_at", "TEXT", 1, null, 0),
    column("updated_at", "TEXT", 1, null, 0),
  ]);
  requireIndexColumns(database, "device_connection_routes_gateway_idx", [
    "gateway_id",
    "lease_expires_at",
  ]);
}

type Column = Readonly<{
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}>;

function column(
  name: string,
  type: string,
  notnull: number,
  dfltValue: string | null,
  pk: number,
): Column {
  return { name, type, notnull, dflt_value: dfltValue, pk };
}

function requireStrictTable(
  database: DatabaseSync,
  table: string,
  expected: readonly Column[],
): void {
  const tableRow = database
    .prepare("SELECT strict FROM pragma_table_list WHERE name = ?")
    .get(table) as { strict: number } | undefined;
  const columns = database
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .map(({ name, type, notnull, dflt_value, pk }) => ({
      name,
      type,
      notnull,
      dflt_value,
      pk,
    }));
  if (
    tableRow?.strict !== 1 ||
    JSON.stringify(columns) !== JSON.stringify(expected)
  ) {
    throw new DeviceGatewayError("device_dispatch_schema_invalid");
  }
}

function requireUniqueColumns(
  database: DatabaseSync,
  table: string,
  expected: readonly string[],
): void {
  const indexes = database
    .prepare(`PRAGMA index_list('${table}')`)
    .all() as Array<{ name: string; unique: number }>;
  const found = indexes.some((index) => {
    if (index.unique !== 1) return false;
    const columns = database
      .prepare(`PRAGMA index_info('${index.name}')`)
      .all()
      .map((row) => String((row as { name: string }).name));
    return JSON.stringify(columns) === JSON.stringify(expected);
  });
  if (!found) throw new DeviceGatewayError("device_dispatch_schema_invalid");
}

function requireCompositeKindForeignKey(
  database: DatabaseSync,
  table: string,
): void {
  const rows = database
    .prepare(`PRAGMA foreign_key_list('${table}')`)
    .all() as Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  const group = rows
    .filter((row) => row.table === "device_execution_kinds")
    .sort((left, right) => left.seq - right.seq);
  if (
    group.length !== 2 ||
    group[0]?.from !== "execution_id" ||
    group[0]?.to !== "execution_id" ||
    group[1]?.from !== "command_kind" ||
    group[1]?.to !== "command_kind" ||
    group.some((row) => row.on_delete !== "RESTRICT")
  ) {
    throw new DeviceGatewayError("device_dispatch_schema_invalid");
  }
}

function requireTableSql(
  database: DatabaseSync,
  table: string,
  fragments: readonly string[],
): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  const sql = row?.sql.replaceAll(/\s+/gu, " ") ?? "";
  if (
    row === undefined ||
    fragments.some(
      (fragment) => !sql.includes(fragment.replaceAll(/\s+/gu, " ")),
    )
  ) {
    throw new DeviceGatewayError("device_dispatch_schema_invalid");
  }
}

function requireIndexColumns(
  database: DatabaseSync,
  index: string,
  expected: readonly string[],
): void {
  const columns = database
    .prepare(`PRAGMA index_info('${index}')`)
    .all()
    .map((row) => String((row as { name: string }).name));
  if (JSON.stringify(columns) !== JSON.stringify(expected)) {
    throw new DeviceGatewayError("device_dispatch_schema_invalid");
  }
}

function transaction(database: DatabaseSync, operation: () => void): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    operation();
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the migration or assertion failure.
    }
    throw error;
  }
}
