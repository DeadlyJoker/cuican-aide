import { DatabaseSync } from "node:sqlite";
import type { DeviceFilesystemReadCommand } from "@crewon/contracts";

import { DeviceGatewayError } from "./device-gateway-error.ts";
import { configureSqliteDeviceGatewayDatabase } from "./sqlite-device-dispatch-schema.ts";
import {
  InMemoryWorkspaceReadDispatchStore,
  type WorkspaceReadDispatchRecord,
  type WorkspaceReadDispatchStorePort,
  type WorkspaceReadRouteFence,
} from "./workspace-read-dispatch-store.ts";

/** SQLite-backed workspace-read receipt authority. */
export class SqliteWorkspaceReadDispatchStore
  implements WorkspaceReadDispatchStorePort
{
  readonly #database: DatabaseSync;
  readonly #inner: InMemoryWorkspaceReadDispatchStore;
  #closed = false;

  constructor(
    path: string,
    config: {
      now: () => Date;
      currentRoute: (deviceId: string) => WorkspaceReadRouteFence | null;
    },
  ) {
    this.#database = new DatabaseSync(path);
    configureSqliteDeviceGatewayDatabase(this.#database, path);
    const rows = (
      this.#database
        .prepare("SELECT record_json FROM workspace_read_dispatch_records")
        .all() as { record_json: string }[]
    ).map(
      ({ record_json }) =>
        JSON.parse(record_json) as WorkspaceReadDispatchRecord,
    );
    this.#inner = new InMemoryWorkspaceReadDispatchStore({
      ...config,
      initialRecords: rows,
    });
  }
  async ready(): Promise<void> {
    this.#assertOpen();
  }
  async prepare(
    command: DeviceFilesystemReadCommand,
    route: WorkspaceReadRouteFence,
    at: string,
  ) {
    this.#assertOpen();
    const value = await this.#inner.prepare(command, route, at);
    this.#write(value.record);
    return value;
  }
  async commit(input: Parameters<WorkspaceReadDispatchStorePort["commit"]>[0]) {
    this.#assertOpen();
    const value = await this.#inner.commit(input);
    this.#write(value.record);
    return value;
  }
  async load(executionId: string) {
    this.#assertOpen();
    return this.#inner.load(executionId);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#inner.close();
    this.#database.close();
  }
  #write(record: WorkspaceReadDispatchRecord): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          "INSERT INTO device_execution_kinds (execution_id, command_kind) VALUES (?, 'workspaceRead') ON CONFLICT (execution_id) DO NOTHING",
        )
        .run(record.executionId);
      const kind = this.#database
        .prepare(
          "SELECT command_kind FROM device_execution_kinds WHERE execution_id = ?",
        )
        .get(record.executionId) as { command_kind: string };
      if (kind.command_kind !== "workspaceRead")
        throw new DeviceGatewayError("device_dispatch_kind_conflict");
      this.#database
        .prepare(
          "INSERT INTO workspace_read_dispatch_records (execution_id, record_json) VALUES (?, ?) ON CONFLICT (execution_id) DO UPDATE SET record_json = excluded.record_json",
        )
        .run(record.executionId, JSON.stringify(record));
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
  #assertOpen(): void {
    if (this.#closed)
      throw new DeviceGatewayError("workspace_read_store_closed");
  }
}
