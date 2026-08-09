import { DatabaseSync } from "node:sqlite";

import {
  parseDeviceExecutionCommand,
  parseDeviceGatewayDispatchResolution,
  type DeviceExecutionCommand,
  type DeviceGatewayDispatchResolution,
} from "@crewon/contracts";

import { deviceDispatchFingerprint } from "./device-dispatch-identity.ts";
import {
  parseDeviceDispatchAuthorityRecord,
  type DeviceDispatchAuthorityRecord,
  type DeviceDispatchStorePort,
  type PrepareDeviceDispatchResult,
} from "./device-dispatch-store.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";

const SCHEMA_VERSION = 1;

type DispatchRow = Readonly<{
  execution_id: string;
  fingerprint: string;
  command_json: string;
  resolution_json: string | null;
  created_at: string;
  updated_at: string;
}>;

export class SqliteDeviceDispatchStore implements DeviceDispatchStorePort {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    if (path.trim().length === 0 || path.includes("\0")) {
      throw new DeviceGatewayError("device_dispatch_database_path_invalid");
    }
    this.#database = new DatabaseSync(path, {
      open: true,
      readOnly: false,
      enableForeignKeyConstraints: true,
      allowExtension: false,
    });
    try {
      configureDatabase(this.#database, path);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  async ready(): Promise<void> {
    this.#assertOpen();
  }

  async prepare(
    input: DeviceExecutionCommand,
    preparedAt: string,
  ): Promise<PrepareDeviceDispatchResult> {
    this.#assertOpen();
    const command = parseDeviceExecutionCommand(input);
    const candidate = parseDeviceDispatchAuthorityRecord({
      executionId: command.executionId,
      fingerprint: deviceDispatchFingerprint(command),
      command,
      resolution: null,
      createdAt: preparedAt,
      updatedAt: preparedAt,
    });
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.#database
        .prepare(
          `INSERT INTO device_dispatch_records (
             execution_id, fingerprint, command_json, resolution_json,
             created_at, updated_at
           ) VALUES (?, ?, ?, NULL, ?, ?)
           ON CONFLICT(execution_id) DO NOTHING`,
        )
        .run(
          candidate.executionId,
          candidate.fingerprint,
          JSON.stringify(candidate.command),
          candidate.createdAt,
          candidate.updatedAt,
        );
      const record = this.#loadRequired(candidate.executionId);
      requireFingerprint(record, candidate.fingerprint);
      this.#database.exec("COMMIT");
      return {
        outcome: inserted.changes === 1 ? "created" : "existing",
        record,
      };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async complete(
    input: DeviceExecutionCommand,
    inputResolution: DeviceGatewayDispatchResolution,
    completedAt: string,
  ): Promise<DeviceDispatchAuthorityRecord> {
    this.#assertOpen();
    const command = parseDeviceExecutionCommand(input);
    const resolution = parseDeviceGatewayDispatchResolution(inputResolution);
    const fingerprint = deviceDispatchFingerprint(command);
    const candidate = parseDeviceDispatchAuthorityRecord({
      executionId: command.executionId,
      fingerprint,
      command,
      resolution,
      createdAt: completedAt,
      updatedAt: completedAt,
    });
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.#loadRequired(command.executionId);
      requireFingerprint(prior, fingerprint);
      if (prior.resolution !== null) {
        if (JSON.stringify(prior.resolution) !== JSON.stringify(resolution)) {
          throw new DeviceGatewayError("device_dispatch_terminal_conflict");
        }
        this.#database.exec("COMMIT");
        return prior;
      }
      this.#database
        .prepare(
          `UPDATE device_dispatch_records
              SET resolution_json = ?, updated_at = ?
            WHERE execution_id = ? AND resolution_json IS NULL`,
        )
        .run(
          JSON.stringify(candidate.resolution),
          candidate.updatedAt,
          candidate.executionId,
        );
      const completed = this.#loadRequired(command.executionId);
      this.#database.exec("COMMIT");
      return completed;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async load(
    executionId: string,
  ): Promise<DeviceDispatchAuthorityRecord | null> {
    this.#assertOpen();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(executionId)) {
      throw new DeviceGatewayError("device_execution_id_invalid");
    }
    return this.#load(executionId);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#database.close();
  }

  #load(executionId: string): DeviceDispatchAuthorityRecord | null {
    const row = this.#database
      .prepare(
        `SELECT execution_id, fingerprint, command_json, resolution_json,
                created_at, updated_at
           FROM device_dispatch_records
          WHERE execution_id = ?`,
      )
      .get(executionId) as DispatchRow | undefined;
    return row === undefined ? null : recordFromRow(row);
  }

  #loadRequired(executionId: string): DeviceDispatchAuthorityRecord {
    const record = this.#load(executionId);
    if (record === null) {
      throw new DeviceGatewayError("device_dispatch_authority_missing");
    }
    return record;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DeviceGatewayError("device_dispatch_store_closed");
    }
  }
}

function configureDatabase(database: DatabaseSync, path: string): void {
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
  if (version === 0) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`
        CREATE TABLE device_dispatch_records (
          execution_id TEXT PRIMARY KEY NOT NULL,
          fingerprint TEXT NOT NULL CHECK (
            length(fingerprint) = 71 AND fingerprint GLOB 'sha256:[0-9a-f]*'
          ),
          command_json TEXT NOT NULL,
          resolution_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
          CHECK (json_valid(command_json))
        ) STRICT;
        PRAGMA user_version = 1;
      `);
      database.exec("COMMIT");
    } catch (error) {
      rollback(database);
      throw error;
    }
  }
}

function recordFromRow(row: DispatchRow): DeviceDispatchAuthorityRecord {
  let command: unknown;
  let resolution: unknown = null;
  try {
    command = JSON.parse(row.command_json);
    if (row.resolution_json !== null) {
      resolution = JSON.parse(row.resolution_json);
    }
  } catch (error) {
    throw new DeviceGatewayError("device_dispatch_authority_corrupt", {
      cause: error,
    });
  }
  return parseDeviceDispatchAuthorityRecord({
    executionId: row.execution_id,
    fingerprint: row.fingerprint,
    command,
    resolution,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function requireFingerprint(
  record: DeviceDispatchAuthorityRecord,
  fingerprint: string,
): void {
  if (record.fingerprint !== fingerprint) {
    throw new DeviceGatewayError("device_dispatch_identity_conflict");
  }
}

function rollback(database: DatabaseSync): void {
  if (database.isTransaction) {
    database.exec("ROLLBACK");
  }
}
