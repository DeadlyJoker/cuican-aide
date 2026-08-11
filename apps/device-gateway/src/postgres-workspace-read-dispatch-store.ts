import type { DeviceFilesystemReadCommand } from "@crewon/contracts";
import { Pool } from "pg";

import { DeviceGatewayError } from "./device-gateway-error.ts";
import { migratePostgresDeviceDispatchSchema } from "./postgres-device-dispatch-schema.ts";
import type { PostgresDeviceDispatchStoreOptions } from "./postgres-device-dispatch-store.ts";
import { requirePostgresWorkspaceSchema } from "./postgres-workspace-dispatch-support.ts";
import {
  InMemoryWorkspaceReadDispatchStore,
  type WorkspaceReadDispatchRecord,
  type WorkspaceReadDispatchStorePort,
  type WorkspaceReadRouteFence,
} from "./workspace-read-dispatch-store.ts";

/** PostgreSQL-backed workspace-read receipt authority. */
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
  #inner: InMemoryWorkspaceReadDispatchStore | null = null;
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
    if (this.#inner !== null) return;
    await migratePostgresDeviceDispatchSchema(this.#pool, this.#schema);
    const rows = await this.#pool.query<{
      record_json: WorkspaceReadDispatchRecord;
    }>(
      `SELECT record_json FROM ${this.#schema}.workspace_read_dispatch_records`,
    );
    this.#inner = new InMemoryWorkspaceReadDispatchStore({
      ...this.#config,
      initialRecords: rows.rows.map((row) => row.record_json),
    });
  }
  async prepare(
    command: DeviceFilesystemReadCommand,
    route: WorkspaceReadRouteFence,
    at: string,
  ) {
    const inner = await this.#required();
    const value = await inner.prepare(command, route, at);
    await this.#write(value.record);
    return value;
  }
  async commit(input: Parameters<WorkspaceReadDispatchStorePort["commit"]>[0]) {
    const inner = await this.#required();
    const value = await inner.commit(input);
    await this.#write(value.record);
    return value;
  }
  async load(executionId: string) {
    return (await this.#required()).load(executionId);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#inner?.close();
    if (this.#ownsPool) await this.#pool.end();
  }
  async #required() {
    await this.ready();
    return this.#inner!;
  }
  async #write(record: WorkspaceReadDispatchRecord): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${this.#schema}.device_execution_kinds (execution_id, command_kind) VALUES ($1, 'workspaceRead') ON CONFLICT (execution_id) DO NOTHING`,
        [record.executionId],
      );
      const kind = await client.query<{ command_kind: string }>(
        `SELECT command_kind FROM ${this.#schema}.device_execution_kinds WHERE execution_id = $1 FOR UPDATE`,
        [record.executionId],
      );
      if (kind.rows[0]?.command_kind !== "workspaceRead")
        throw new DeviceGatewayError("device_dispatch_kind_conflict");
      await client.query(
        `INSERT INTO ${this.#schema}.workspace_read_dispatch_records (execution_id, record_json) VALUES ($1, $2) ON CONFLICT (execution_id) DO UPDATE SET record_json = excluded.record_json`,
        [record.executionId, record],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  #assertOpen(): void {
    if (this.#closed)
      throw new DeviceGatewayError("workspace_read_store_closed");
  }
}
