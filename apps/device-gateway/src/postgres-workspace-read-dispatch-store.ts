import type { DeviceFilesystemReadCommand } from "@crewon/contracts";
import { Pool, type PoolClient } from "pg";

import { DeviceGatewayError } from "./device-gateway-error.ts";
import { migratePostgresDeviceDispatchSchema } from "./postgres-device-dispatch-schema.ts";
import type { PostgresDeviceDispatchStoreOptions } from "./postgres-device-dispatch-store.ts";
import { requirePostgresWorkspaceSchema } from "./postgres-workspace-dispatch-support.ts";
import {
  InMemoryWorkspaceReadDispatchStore,
  parseWorkspaceReadDispatchRecord,
  type WorkspaceReadDispatchRecord,
  type WorkspaceReadDispatchStorePort,
  type WorkspaceReadRouteFence,
} from "./workspace-read-dispatch-store.ts";

/** PostgreSQL-backed transactional workspace-read receipt authority. */
export class PostgresWorkspaceReadDispatchStore
  implements WorkspaceReadDispatchStorePort
{
  readonly #pool: Pool;
  readonly #ownsPool: boolean;
  readonly #schema: string;
  readonly #config: {
    now: () => Date;
    currentRoute: (deviceId: string) => WorkspaceReadRouteFence | null;
  };
  #ready: Promise<void> | null = null;
  #closed = false;

  constructor(
    options: PostgresDeviceDispatchStoreOptions & {
      now: () => Date;
      currentRoute: (deviceId: string) => WorkspaceReadRouteFence | null;
    },
  ) {
    if (
      (options.pool === undefined) ===
      (options.connectionString === undefined)
    )
      throw new DeviceGatewayError("device_dispatch_postgres_config_invalid");
    this.#schema = requirePostgresWorkspaceSchema(
      options.schema ?? "crewon_device_gateway",
    );
    this.#pool =
      options.pool ?? new Pool({ connectionString: options.connectionString });
    this.#ownsPool = options.pool === undefined;
    this.#config = { now: options.now, currentRoute: options.currentRoute };
  }
  async ready(): Promise<void> {
    this.#assertOpen();
    this.#ready ??= migratePostgresDeviceDispatchSchema(
      this.#pool,
      this.#schema,
    );
    await this.#ready;
  }
  async prepare(
    command: DeviceFilesystemReadCommand,
    route: WorkspaceReadRouteFence,
    at: string,
  ) {
    return this.#mutate(command.executionId, (authority) =>
      authority.prepare(command, route, at),
    );
  }
  async commit(input: Parameters<WorkspaceReadDispatchStorePort["commit"]>[0]) {
    return this.#mutate(input.command.executionId, (authority) =>
      authority.commit(input),
    );
  }
  async load(executionId: string): Promise<WorkspaceReadDispatchRecord | null> {
    await this.ready();
    const result = await this.#pool.query<{
      command_kind: string | null;
      record_json: unknown;
    }>(
      `SELECT kinds.command_kind, records.record_json
         FROM ${this.#schema}.device_execution_kinds kinds
         LEFT JOIN ${this.#schema}.workspace_read_dispatch_records records USING (execution_id)
        WHERE kinds.execution_id = $1`,
      [executionId],
    );
    if (result.rows.length === 0) return null;
    return this.#parseRow(result.rows[0]!);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ownsPool) await this.#pool.end();
  }

  async #mutate<T extends { record: WorkspaceReadDispatchRecord }>(
    executionId: string,
    transition: (authority: InMemoryWorkspaceReadDispatchStore) => Promise<T>,
  ): Promise<T> {
    await this.ready();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${this.#schema}.device_execution_kinds (execution_id, command_kind) VALUES ($1, 'workspaceRead') ON CONFLICT (execution_id) DO NOTHING`,
        [executionId],
      );
      const prior = await this.#lockedRecord(client, executionId);
      const authority = new InMemoryWorkspaceReadDispatchStore({
        ...this.#config,
        initialRecords: prior === null ? [] : [prior],
      });
      const value = await transition(authority);
      await client.query(
        `INSERT INTO ${this.#schema}.workspace_read_dispatch_records (execution_id, record_json)
         VALUES ($1, $2) ON CONFLICT (execution_id) DO UPDATE SET record_json = EXCLUDED.record_json`,
        [executionId, value.record],
      );
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
  async #lockedRecord(
    client: PoolClient,
    executionId: string,
  ): Promise<WorkspaceReadDispatchRecord | null> {
    const kind = await client.query<{ command_kind: string }>(
      `SELECT command_kind FROM ${this.#schema}.device_execution_kinds WHERE execution_id = $1 FOR UPDATE`,
      [executionId],
    );
    if (kind.rows[0]?.command_kind !== "workspaceRead")
      throw new DeviceGatewayError("device_dispatch_kind_conflict");
    const detail = await client.query<{ record_json: unknown }>(
      `SELECT record_json FROM ${this.#schema}.workspace_read_dispatch_records WHERE execution_id = $1 FOR UPDATE`,
      [executionId],
    );
    return detail.rows[0] === undefined
      ? null
      : parseWorkspaceReadDispatchRecord(detail.rows[0].record_json);
  }
  #parseRow(row: {
    command_kind: string | null;
    record_json: unknown;
  }): WorkspaceReadDispatchRecord {
    if (row.command_kind !== "workspaceRead" || row.record_json === null)
      throw new DeviceGatewayError("workspace_read_stored_state_invalid");
    return parseWorkspaceReadDispatchRecord(row.record_json);
  }
  #assertOpen(): void {
    if (this.#closed)
      throw new DeviceGatewayError("workspace_read_store_closed");
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    /* preserve authority failure */
  }
}
