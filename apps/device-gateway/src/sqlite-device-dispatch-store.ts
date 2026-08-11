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
import { configureSqliteDeviceGatewayDatabase } from "./sqlite-device-dispatch-schema.ts";
import { requireSqliteExecutionAuthorityState } from "./sqlite-workspace-dispatch-support.ts";

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
      configureSqliteDeviceGatewayDatabase(this.#database, path);
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
      const { kind } = requireSqliteExecutionAuthorityState(
        this.#database,
        candidate.executionId,
      );
      const prior = this.#load(candidate.executionId);
      if (prior !== null) {
        if (kind !== "tool") {
          throw new DeviceGatewayError("device_dispatch_stored_state_invalid");
        }
        requireFingerprint(prior, candidate.fingerprint);
        this.#database.exec("COMMIT");
        return { outcome: "existing", record: prior };
      }
      if (kind === "workspaceList") {
        throw new DeviceGatewayError("device_dispatch_kind_conflict");
      }
      if (kind === "tool") {
        throw new DeviceGatewayError("device_dispatch_stored_state_invalid");
      }
      this.#database
        .prepare(
          `INSERT INTO device_execution_kinds (execution_id, command_kind)
           VALUES (?, 'tool')`,
        )
        .run(candidate.executionId);
      this.#database
        .prepare(
          `INSERT INTO device_dispatch_records (
             execution_id, fingerprint, command_json, resolution_json,
             created_at, updated_at
           ) VALUES (?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          candidate.executionId,
          candidate.fingerprint,
          JSON.stringify(candidate.command),
          candidate.createdAt,
          candidate.updatedAt,
        );
      const record = this.#loadRequired(candidate.executionId);
      this.#database.exec("COMMIT");
      return { outcome: "created", record };
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
      const { kind } = requireSqliteExecutionAuthorityState(
        this.#database,
        command.executionId,
      );
      const prior = this.#load(command.executionId);
      if (kind === null && prior === null) {
        throw new DeviceGatewayError("device_dispatch_authority_missing");
      }
      if (kind === "workspaceList") {
        throw new DeviceGatewayError("device_dispatch_kind_conflict");
      }
      if (kind !== "tool" || prior === null) {
        throw new DeviceGatewayError("device_dispatch_stored_state_invalid");
      }
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
    this.#database.exec("BEGIN");
    try {
      const { kind } = requireSqliteExecutionAuthorityState(
        this.#database,
        executionId,
      );
      const record = this.#load(executionId);
      if (kind === "workspaceList") {
        this.#database.exec("COMMIT");
        return null;
      }
      this.#database.exec("COMMIT");
      return record;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
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
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original transaction failure.
  }
}
