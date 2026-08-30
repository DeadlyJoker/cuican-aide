import { DatabaseSync } from "node:sqlite";
import type { DeviceFilesystemReadCommand } from "@crewon/contracts";

import { DeviceGatewayError } from "./device-gateway-error.ts";
import { configureSqliteDeviceGatewayDatabase } from "./sqlite-device-dispatch-schema.ts";
import {
  InMemoryWorkspaceReadDispatchStore,
  parseWorkspaceReadDispatchRecord,
  type WorkspaceReadDispatchRecord,
  type WorkspaceReadDispatchStorePort,
  type WorkspaceReadCurrentRouteResolver,
  type WorkspaceReadRouteFence,
} from "./workspace-read-dispatch-store.ts";

/** SQLite-backed transactional workspace-read receipt authority. */
export class SqliteWorkspaceReadDispatchStore
  implements WorkspaceReadDispatchStorePort
{
  readonly #database: DatabaseSync;
  readonly #config: {
    now: () => Date;
    currentRoute: WorkspaceReadCurrentRouteResolver;
  };
  #tail: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | null = null;
  #closing = false;
  #closed = false;

  constructor(
    path: string,
    config: {
      now: () => Date;
      currentRoute: WorkspaceReadCurrentRouteResolver;
    },
  ) {
    this.#database = new DatabaseSync(path);
    configureSqliteDeviceGatewayDatabase(this.#database, path);
    this.#config = config;
  }
  async ready(): Promise<void> {
    this.#assertAccepting();
  }

  prepare(
    command: DeviceFilesystemReadCommand,
    route: WorkspaceReadRouteFence,
    at: string,
  ) {
    return this.#enqueue(async () =>
      this.#mutate(command.executionId, (authority) =>
        authority.prepare(command, route, at),
      ),
    );
  }
  commit(input: Parameters<WorkspaceReadDispatchStorePort["commit"]>[0]) {
    return this.#enqueue(async () =>
      this.#mutate(input.command.executionId, (authority) =>
        authority.commit(input),
      ),
    );
  }
  load(executionId: string) {
    return this.#enqueue(async () => this.#read(executionId));
  }
  async close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = this.#finishClose();
    return this.#closePromise;
  }

  async #mutate<T extends { record: WorkspaceReadDispatchRecord }>(
    executionId: string,
    transition: (authority: InMemoryWorkspaceReadDispatchStore) => Promise<T>,
  ): Promise<T> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.#read(executionId);
      const authority = new InMemoryWorkspaceReadDispatchStore({
        ...this.#config,
        initialRecords: prior === null ? [] : [prior],
      });
      const value = await transition(authority);
      this.#claimKind(executionId);
      this.#database
        .prepare(
          "INSERT INTO workspace_read_dispatch_records (execution_id, record_json) VALUES (?, ?) ON CONFLICT (execution_id) DO UPDATE SET record_json = excluded.record_json",
        )
        .run(executionId, JSON.stringify(value.record));
      this.#database.exec("COMMIT");
      return value;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
  #read(executionId: string): WorkspaceReadDispatchRecord | null {
    this.#assertDatabaseOpen();
    const kind = this.#database
      .prepare(
        "SELECT command_kind FROM device_execution_kinds WHERE execution_id = ?",
      )
      .get(executionId) as { command_kind: string } | undefined;
    const row = this.#database
      .prepare(
        "SELECT record_json FROM workspace_read_dispatch_records WHERE execution_id = ?",
      )
      .get(executionId) as { record_json: string } | undefined;
    if (kind === undefined && row === undefined) return null;
    if (kind?.command_kind !== "workspaceRead" || row === undefined)
      throw new DeviceGatewayError("workspace_read_stored_state_invalid");
    return parseWorkspaceReadDispatchRecord(JSON.parse(row.record_json));
  }
  #claimKind(executionId: string): void {
    this.#database
      .prepare(
        "INSERT INTO device_execution_kinds (execution_id, command_kind) VALUES (?, 'workspaceRead') ON CONFLICT (execution_id) DO NOTHING",
      )
      .run(executionId);
    const row = this.#database
      .prepare(
        "SELECT command_kind FROM device_execution_kinds WHERE execution_id = ?",
      )
      .get(executionId) as { command_kind: string };
    if (row.command_kind !== "workspaceRead")
      throw new DeviceGatewayError("device_dispatch_kind_conflict");
  }
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertAccepting();
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async #finishClose(): Promise<void> {
    await this.#tail;
    this.#database.close();
    this.#closed = true;
  }
  #assertAccepting(): void {
    if (this.#closing || this.#closed)
      throw new DeviceGatewayError("workspace_read_store_closed");
  }
  #assertDatabaseOpen(): void {
    if (this.#closed)
      throw new DeviceGatewayError("workspace_read_store_closed");
  }
}
