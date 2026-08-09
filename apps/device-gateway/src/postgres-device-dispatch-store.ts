import { isDeepStrictEqual } from "node:util";

import {
  parseDeviceExecutionCommand,
  parseDeviceGatewayDispatchResolution,
  type DeviceExecutionCommand,
  type DeviceGatewayDispatchResolution,
} from "@crewon/contracts";
import { Pool, type PoolClient, type PoolConfig } from "pg";

import { deviceDispatchFingerprint } from "./device-dispatch-identity.ts";
import {
  parseDeviceConnectionRoute,
  requireLeaseDuration,
  validateClaimDeviceConnectionInput,
  validateDeviceId,
  validateFenceDeviceConnectionInput,
  type ClaimDeviceConnectionInput,
  type DeviceConnectionRoute,
  type DeviceConnectionRouteStorePort,
  type FenceDeviceConnectionInput,
} from "./device-connection-route-store.ts";
import {
  parseDeviceDispatchAuthorityRecord,
  type DeviceDispatchAuthorityRecord,
  type DeviceDispatchStorePort,
  type PrepareDeviceDispatchResult,
} from "./device-dispatch-store.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";

const SCHEMA_VERSION = 2;
const DEFAULT_SCHEMA = "crewon_device_gateway";

type DispatchRow = Readonly<{
  execution_id: string;
  fingerprint: string;
  command_json: unknown;
  resolution_json: unknown | null;
  created_at: string;
  updated_at: string;
}>;

type ConnectionRouteRow = Readonly<{
  device_id: string;
  gateway_id: string;
  connection_id: string;
  epoch: string | number;
  lease_expires_at: string;
  updated_at: string;
}>;

export type PostgresDeviceDispatchStoreOptions = Readonly<{
  connectionString?: string;
  pool?: Pool;
  schema?: string;
  maxPoolSize?: number;
  statementTimeoutMs?: number;
}>;

/** PostgreSQL-backed Team authority for Device execution identity and terminal receipts. */
export class PostgresDeviceDispatchStore
  implements DeviceDispatchStorePort, DeviceConnectionRouteStorePort
{
  readonly #pool: Pool;
  readonly #ownsPool: boolean;
  readonly #schema: string;
  readonly #ready: Promise<void>;
  #closed = false;

  constructor(options: PostgresDeviceDispatchStoreOptions) {
    if (
      (options.pool === undefined) ===
      (options.connectionString === undefined)
    ) {
      throw new DeviceGatewayError("device_dispatch_postgres_config_invalid");
    }
    this.#schema = requireSchema(options.schema ?? DEFAULT_SCHEMA);
    if (options.pool !== undefined) {
      this.#pool = options.pool;
      this.#ownsPool = false;
    } else {
      this.#pool = new Pool(
        poolConfig(
          options.connectionString as string,
          options.maxPoolSize,
          options.statementTimeoutMs,
        ),
      );
      this.#ownsPool = true;
    }
    this.#ready = this.#migrate();
  }

  async ready(): Promise<void> {
    this.#assertOpen();
    await this.#ready;
  }

  async prepare(
    input: DeviceExecutionCommand,
    preparedAt: string,
  ): Promise<PrepareDeviceDispatchResult> {
    this.#assertOpen();
    await this.#ready;
    const command = parseDeviceExecutionCommand(input);
    const candidate = parseDeviceDispatchAuthorityRecord({
      executionId: command.executionId,
      fingerprint: deviceDispatchFingerprint(command),
      command,
      resolution: null,
      createdAt: preparedAt,
      updatedAt: preparedAt,
    });
    try {
      const inserted = await this.#pool.query<{ execution_id: string }>(
        `INSERT INTO ${this.#schema}.device_dispatch_records (
           execution_id, fingerprint, command_json, resolution_json,
           created_at, updated_at
         ) VALUES ($1, $2, $3::jsonb, NULL, clock_timestamp(), clock_timestamp())
         ON CONFLICT (execution_id) DO NOTHING
         RETURNING execution_id`,
        [
          candidate.executionId,
          candidate.fingerprint,
          JSON.stringify(candidate.command),
        ],
      );
      const record = await this.#loadRequired(candidate.executionId);
      requireFingerprint(record, candidate.fingerprint);
      return {
        outcome: inserted.rowCount === 1 ? "created" : "existing",
        record,
      };
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async complete(
    input: DeviceExecutionCommand,
    inputResolution: DeviceGatewayDispatchResolution,
    completedAt: string,
  ): Promise<DeviceDispatchAuthorityRecord> {
    this.#assertOpen();
    await this.#ready;
    const command = parseDeviceExecutionCommand(input);
    const resolution = parseDeviceGatewayDispatchResolution(inputResolution);
    const candidate = parseDeviceDispatchAuthorityRecord({
      executionId: command.executionId,
      fingerprint: deviceDispatchFingerprint(command),
      command,
      resolution,
      createdAt: completedAt,
      updatedAt: completedAt,
    });
    const client = await this.#pool.connect().catch((error: unknown) => {
      throw normalizePostgresError(error);
    });
    try {
      await client.query("BEGIN");
      const prior = await this.#loadRequired(
        candidate.executionId,
        client,
        true,
      );
      requireFingerprint(prior, candidate.fingerprint);
      if (prior.resolution !== null) {
        if (!isDeepStrictEqual(prior.resolution, candidate.resolution)) {
          throw new DeviceGatewayError("device_dispatch_terminal_conflict");
        }
        await client.query("COMMIT");
        return prior;
      }
      await client.query(
        `UPDATE ${this.#schema}.device_dispatch_records
            SET resolution_json = $1::jsonb,
                updated_at = clock_timestamp()
          WHERE execution_id = $2 AND resolution_json IS NULL`,
        [JSON.stringify(candidate.resolution), candidate.executionId],
      );
      const completed = await this.#loadRequired(candidate.executionId, client);
      await client.query("COMMIT");
      return completed;
    } catch (error) {
      await rollback(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async load(
    executionId: string,
  ): Promise<DeviceDispatchAuthorityRecord | null> {
    this.#assertOpen();
    await this.#ready;
    requireExecutionId(executionId);
    try {
      return await this.#load(executionId, this.#pool);
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async claimConnection(
    rawInput: ClaimDeviceConnectionInput,
  ): Promise<DeviceConnectionRoute> {
    this.#assertOpen();
    await this.#ready;
    const input = validateClaimDeviceConnectionInput(rawInput);
    try {
      const result = await this.#pool.query<ConnectionRouteRow>(
        `INSERT INTO ${this.#schema}.device_connection_routes (
           device_id, gateway_id, connection_id, epoch,
           lease_expires_at, updated_at
         ) VALUES (
           $1, $2, $3, 1,
           clock_timestamp() + $4::double precision * interval '1 millisecond',
           clock_timestamp()
         )
         ON CONFLICT (device_id) DO UPDATE
           SET gateway_id = EXCLUDED.gateway_id,
               connection_id = EXCLUDED.connection_id,
               epoch = ${this.#schema}.device_connection_routes.epoch + 1,
               lease_expires_at = EXCLUDED.lease_expires_at,
               updated_at = EXCLUDED.updated_at
         RETURNING device_id, gateway_id, connection_id, epoch,
                   to_char(lease_expires_at AT TIME ZONE 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS lease_expires_at,
                   to_char(updated_at AT TIME ZONE 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`,
        [
          input.deviceId,
          input.gatewayId,
          input.connectionId,
          input.leaseDurationMs,
        ],
      );
      return connectionRouteFromRow(requiredRouteRow(result.rows[0]));
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async renewConnection(
    rawInput: FenceDeviceConnectionInput &
      Readonly<{ leaseDurationMs: number }>,
  ): Promise<DeviceConnectionRoute | null> {
    this.#assertOpen();
    await this.#ready;
    const input = {
      ...validateFenceDeviceConnectionInput(rawInput),
      leaseDurationMs: requireLeaseDuration(rawInput.leaseDurationMs),
    };
    try {
      const result = await this.#pool.query<ConnectionRouteRow>(
        `UPDATE ${this.#schema}.device_connection_routes
            SET lease_expires_at = clock_timestamp()
                                 + $5::double precision * interval '1 millisecond',
                updated_at = clock_timestamp()
          WHERE device_id = $1
            AND gateway_id = $2
            AND connection_id = $3
            AND epoch = $4
            AND lease_expires_at > clock_timestamp()
        RETURNING device_id, gateway_id, connection_id, epoch,
                  to_char(lease_expires_at AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS lease_expires_at,
                  to_char(updated_at AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`,
        [
          input.deviceId,
          input.gatewayId,
          input.connectionId,
          input.epoch,
          input.leaseDurationMs,
        ],
      );
      const row = result.rows[0];
      return row === undefined ? null : connectionRouteFromRow(row);
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async releaseConnection(
    rawInput: FenceDeviceConnectionInput,
  ): Promise<boolean> {
    this.#assertOpen();
    await this.#ready;
    const input = validateFenceDeviceConnectionInput(rawInput);
    try {
      const result = await this.#pool.query(
        `DELETE FROM ${this.#schema}.device_connection_routes
          WHERE device_id = $1
            AND gateway_id = $2
            AND connection_id = $3
            AND epoch = $4`,
        [input.deviceId, input.gatewayId, input.connectionId, input.epoch],
      );
      return result.rowCount === 1;
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async loadConnection(
    deviceId: string,
  ): Promise<DeviceConnectionRoute | null> {
    this.#assertOpen();
    await this.#ready;
    validateDeviceId(deviceId);
    try {
      const result = await this.#pool.query<ConnectionRouteRow>(
        `SELECT device_id, gateway_id, connection_id, epoch,
                to_char(lease_expires_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS lease_expires_at,
                to_char(updated_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
           FROM ${this.#schema}.device_connection_routes
          WHERE device_id = $1 AND lease_expires_at > clock_timestamp()`,
        [deviceId],
      );
      const row = result.rows[0];
      return row === undefined ? null : connectionRouteFromRow(row);
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      await this.#ready;
    } finally {
      if (this.#ownsPool) {
        await this.#pool.end();
      }
    }
  }

  async #migrate(): Promise<void> {
    const client = await this.#pool.connect().catch((error: unknown) => {
      throw normalizePostgresError(error);
    });
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${this.#schema}:device-dispatch-schema`,
      ]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.#schema}`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.#schema}.device_dispatch_schema (
          component TEXT PRIMARY KEY,
          version INTEGER NOT NULL CHECK (version > 0)
        )
      `);
      const migration = await client.query<{ version: number }>(
        `SELECT version
           FROM ${this.#schema}.device_dispatch_schema
          WHERE component = 'dispatch-authority'`,
      );
      const version = migration.rows[0]?.version;
      if (version !== undefined && version > SCHEMA_VERSION) {
        throw new DeviceGatewayError("device_dispatch_schema_newer");
      }
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.#schema}.device_dispatch_records (
          execution_id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL CHECK (
            fingerprint ~ '^sha256:[0-9a-f]{64}$'
          ),
          command_json JSONB NOT NULL CHECK (
            jsonb_typeof(command_json) = 'object'
          ),
          resolution_json JSONB CHECK (
            resolution_json IS NULL OR jsonb_typeof(resolution_json) = 'object'
          ),
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL CHECK (updated_at >= created_at)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.#schema}.device_connection_routes (
          device_id TEXT PRIMARY KEY,
          gateway_id TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          epoch BIGINT NOT NULL CHECK (epoch > 0),
          lease_expires_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS device_connection_routes_gateway_idx
            ON ${this.#schema}.device_connection_routes (
              gateway_id, lease_expires_at
            )
      `);
      await client.query(
        `INSERT INTO ${this.#schema}.device_dispatch_schema (component, version)
         VALUES ('dispatch-authority', $1)
         ON CONFLICT (component) DO UPDATE SET version = EXCLUDED.version
         WHERE ${this.#schema}.device_dispatch_schema.version <= EXCLUDED.version`,
        [SCHEMA_VERSION],
      );
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async #loadRequired(
    executionId: string,
    queryable: Queryable = this.#pool,
    forUpdate = false,
  ): Promise<DeviceDispatchAuthorityRecord> {
    const record = await this.#load(executionId, queryable, forUpdate);
    if (record === null) {
      throw new DeviceGatewayError("device_dispatch_authority_missing");
    }
    return record;
  }

  async #load(
    executionId: string,
    queryable: Queryable,
    forUpdate = false,
  ): Promise<DeviceDispatchAuthorityRecord | null> {
    const result = await queryable.query<DispatchRow>(
      `SELECT execution_id, fingerprint, command_json, resolution_json,
              to_char(created_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
              to_char(updated_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
         FROM ${this.#schema}.device_dispatch_records
        WHERE execution_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [executionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : recordFromRow(row);
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DeviceGatewayError("device_dispatch_store_closed");
    }
  }
}

type Queryable = Pick<Pool | PoolClient, "query">;

function recordFromRow(row: DispatchRow): DeviceDispatchAuthorityRecord {
  return parseDeviceDispatchAuthorityRecord({
    executionId: row.execution_id,
    fingerprint: row.fingerprint,
    command: row.command_json,
    resolution: row.resolution_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function connectionRouteFromRow(
  row: ConnectionRouteRow,
): DeviceConnectionRoute {
  return parseDeviceConnectionRoute({
    deviceId: row.device_id,
    gatewayId: row.gateway_id,
    connectionId: row.connection_id,
    epoch: Number(row.epoch),
    leaseExpiresAt: row.lease_expires_at,
    updatedAt: row.updated_at,
  });
}

function requiredRouteRow(
  row: ConnectionRouteRow | undefined,
): ConnectionRouteRow {
  if (row === undefined) {
    throw new DeviceGatewayError("device_connection_route_missing");
  }
  return row;
}

function requireFingerprint(
  record: DeviceDispatchAuthorityRecord,
  fingerprint: string,
): void {
  if (record.fingerprint !== fingerprint) {
    throw new DeviceGatewayError("device_dispatch_identity_conflict");
  }
}

function requireExecutionId(executionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(executionId)) {
    throw new DeviceGatewayError("device_execution_id_invalid");
  }
}

function requireSchema(schema: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new DeviceGatewayError("device_dispatch_postgres_schema_invalid");
  }
  return schema;
}

function poolConfig(
  connectionString: string,
  maxPoolSize = 10,
  statementTimeoutMs = 30_000,
): PoolConfig {
  if (connectionString.trim().length === 0) {
    throw new DeviceGatewayError("device_dispatch_postgres_config_invalid");
  }
  if (
    !Number.isSafeInteger(maxPoolSize) ||
    maxPoolSize < 1 ||
    maxPoolSize > 100
  ) {
    throw new DeviceGatewayError("device_dispatch_postgres_pool_invalid");
  }
  if (
    !Number.isSafeInteger(statementTimeoutMs) ||
    statementTimeoutMs < 1 ||
    statementTimeoutMs > 300_000
  ) {
    throw new DeviceGatewayError("device_dispatch_postgres_timeout_invalid");
  }
  return {
    application_name: "crewon-device-gateway",
    connectionString,
    max: maxPoolSize,
    statement_timeout: statementTimeoutMs,
  };
}

function normalizePostgresError(error: unknown): Error {
  if (error instanceof DeviceGatewayError) {
    return error;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (code === "40001" || code === "40P01" || code === "55P03") {
    return new DeviceGatewayError("device_dispatch_store_busy", {
      cause: error,
    });
  }
  return new DeviceGatewayError("device_dispatch_store_failed", {
    cause: error instanceof Error ? error : undefined,
  });
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction failure.
  }
}
