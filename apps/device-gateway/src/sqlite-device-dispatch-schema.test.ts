import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { configureSqliteDeviceGatewayDatabase } from "./sqlite-device-dispatch-schema.ts";

test("migrates populated v2 Workspace authority without breaking child foreign keys", async (context) => {
  const path = await temporaryDatabasePath(context);
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE device_execution_kinds (
      execution_id TEXT PRIMARY KEY NOT NULL,
      command_kind TEXT NOT NULL CHECK (
        command_kind IN ('tool', 'workspaceList')
      ),
      UNIQUE (execution_id, command_kind)
    ) STRICT;
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
    INSERT INTO device_execution_kinds (execution_id, command_kind)
      VALUES ('workspace-execution-1', 'workspaceList');
    INSERT INTO workspace_dispatch_records (execution_id, record_json)
      VALUES ('workspace-execution-1', '{"fixture":"preserved"}');
    INSERT INTO device_connection_routes (
      device_id, gateway_id, connection_id, epoch,
      lease_expires_at, updated_at
    ) VALUES (
      'device-1', 'gateway-1', 'connection-1', 7,
      '2099-08-12T01:00:00.000Z', '2026-08-12T01:00:00.000Z'
    );
    PRAGMA user_version = 2;
  `);

  configureSqliteDeviceGatewayDatabase(database, path);

  assert.deepEqual(
    database
      .prepare(
        `SELECT execution_id, command_kind
           FROM device_execution_kinds
          ORDER BY execution_id`,
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        execution_id: "workspace-execution-1",
        command_kind: "workspaceList",
      },
    ],
  );
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT execution_id, command_kind, record_json
             FROM workspace_dispatch_records`,
        )
        .get(),
    },
    {
      execution_id: "workspace-execution-1",
      command_kind: "workspaceList",
      record_json: '{"fixture":"preserved"}',
    },
  );
  assert.deepEqual(
    database.prepare("PRAGMA foreign_key_check").all(),
    [],
  );
  assert.deepEqual(
    { ...database.prepare("PRAGMA user_version").get() },
    { user_version: 3 },
  );
  assert.deepEqual(
    { ...database.prepare("PRAGMA foreign_keys").get() },
    { foreign_keys: 1 },
  );
  assert.deepEqual(
    { ...database.prepare("PRAGMA legacy_alter_table").get() },
    { legacy_alter_table: 0 },
  );

  database
    .prepare(
      `INSERT INTO device_execution_kinds (execution_id, command_kind)
       VALUES ('workspace-read-execution-1', 'workspaceRead')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO workspace_read_dispatch_records (
         execution_id, record_json
       ) VALUES ('workspace-read-execution-1', '{"fixture":"read"}')`,
    )
    .run();
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

async function temporaryDatabasePath(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "crewon-gateway-migration-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "gateway.sqlite");
}
