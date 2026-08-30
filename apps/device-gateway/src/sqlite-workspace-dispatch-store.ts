import { DatabaseSync } from "node:sqlite";

import {
  parseDeviceWorkspaceListCommand,
  type DeviceWorkspaceListCommand,
} from "@crewon/contracts";

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
import { DeviceGatewayError } from "./device-gateway-error.ts";
import { configureSqliteDeviceGatewayDatabase } from "./sqlite-device-dispatch-schema.ts";
import {
  requireFreshWorkspaceKind,
  requireSqliteExecutionAuthorityState,
  requireWorkspaceFingerprint,
  routeFromSqliteRow,
  sameDeviceConnectionRouteFence,
  workspaceRouteFromDeviceConnectionRoute,
  type SqliteDeviceConnectionRouteRow,
} from "./sqlite-workspace-dispatch-support.ts";
import {
  parseWorkspaceDispatchAuthorityRecord,
  parseWorkspaceDispatchRoute,
  requireWorkspaceDispatchNotBefore,
  sameWorkspaceDispatchJson,
  sameWorkspaceDispatchRouteFence,
  validateAcceptWorkspaceDispatchEventInput,
  validateSettleWorkspaceDispatchEventInput,
  workspaceDispatchFingerprint,
  type WorkspaceDispatchAuthorityRecord,
} from "./workspace-dispatch-authority.ts";
import {
  workspaceDispatchCommitResult,
  type AcceptWorkspaceDispatchEventInput,
  type CommitWorkspaceDispatchEventResult,
  type PrepareWorkspaceDispatchResult,
  type SettleWorkspaceDispatchEventInput,
  type WorkspaceDispatchStorePort,
} from "./workspace-dispatch-store.ts";

type WorkspaceRow = Readonly<{ execution_id: string; record_json: string }>;

export class SqliteWorkspaceDispatchStore
  implements WorkspaceDispatchStorePort, DeviceConnectionRouteStorePort
{
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
    input: DeviceWorkspaceListCommand,
    preparedAt: string,
  ): Promise<PrepareWorkspaceDispatchResult> {
    this.#assertOpen();
    const command = parseDeviceWorkspaceListCommand(input);
    const fingerprint = workspaceDispatchFingerprint(command);
    const candidate = parseWorkspaceDispatchAuthorityRecord({
      commandKind: "workspaceList",
      executionId: command.executionId,
      fingerprint,
      command,
      route: null,
      acceptedEvent: null,
      terminalEvent: null,
      resolution: null,
      createdAt: preparedAt,
      updatedAt: preparedAt,
    });
    return this.#transaction(() => {
      const { kind } = requireSqliteExecutionAuthorityState(
        this.#database,
        candidate.executionId,
        "workspace_dispatch_stored_state_invalid",
      );
      const prior = this.#load(candidate.executionId);
      if (prior !== null) {
        if (kind !== "workspaceList") {
          throw new DeviceGatewayError(
            "workspace_dispatch_stored_state_invalid",
          );
        }
        requireWorkspaceFingerprint(prior, fingerprint);
        return { outcome: "existing", record: prior };
      }
      requireFreshWorkspaceKind(kind);
      this.#database
        .prepare(
          `INSERT INTO device_execution_kinds (execution_id, command_kind)
           VALUES (?, 'workspaceList')`,
        )
        .run(candidate.executionId);
      this.#database
        .prepare(
          `INSERT INTO workspace_dispatch_records (execution_id, record_json)
           VALUES (?, ?)`,
        )
        .run(candidate.executionId, JSON.stringify(candidate));
      return { outcome: "created", record: candidate };
    });
  }

  async acceptEvent(
    rawInput: AcceptWorkspaceDispatchEventInput,
  ): Promise<CommitWorkspaceDispatchEventResult> {
    this.#assertOpen();
    const input = validateAcceptWorkspaceDispatchEventInput(rawInput);
    return this.#transaction(() => {
      const prior = this.#requiredRecord(input.command);
      if (prior.acceptedEvent !== null) {
        if (
          prior.route === null ||
          !sameWorkspaceDispatchRouteFence(prior.route, input.route) ||
          !sameWorkspaceDispatchJson(prior.acceptedEvent, input.event)
        ) {
          throw new DeviceGatewayError("workspace_dispatch_event_conflict");
        }
        return workspaceDispatchCommitResult(
          "replayed",
          prior,
          prior.acceptedEvent,
        );
      }
      const now = this.#databaseNow();
      const currentRoute = this.#loadCurrentRoute(input.command.deviceId);
      if (currentRoute === null) {
        throw new DeviceGatewayError("workspace_dispatch_route_unavailable");
      }
      const expected = parseWorkspaceDispatchRoute(input.route);
      const authoritative =
        workspaceRouteFromDeviceConnectionRoute(currentRoute);
      if (!sameWorkspaceDispatchRouteFence(expected, authoritative)) {
        throw new DeviceGatewayError("workspace_dispatch_route_stale");
      }
      if (Date.parse(now) >= Date.parse(authoritative.leaseExpiresAt)) {
        throw new DeviceGatewayError("workspace_dispatch_route_expired");
      }
      requireWorkspaceDispatchNotBefore(now, prior.updatedAt);
      const committed = parseWorkspaceDispatchAuthorityRecord({
        ...prior,
        route: authoritative,
        acceptedEvent: input.event,
        updatedAt: now,
      });
      this.#write(committed);
      return workspaceDispatchCommitResult("committed", committed, input.event);
    });
  }

  async settleEvent(
    rawInput: SettleWorkspaceDispatchEventInput,
  ): Promise<CommitWorkspaceDispatchEventResult> {
    this.#assertOpen();
    const input = validateSettleWorkspaceDispatchEventInput(rawInput);
    return this.#transaction(() => {
      const prior = this.#requiredRecord(input.command);
      if (prior.acceptedEvent === null || prior.route === null) {
        throw new DeviceGatewayError("workspace_dispatch_accepted_missing");
      }
      if (
        !sameWorkspaceDispatchRouteFence(prior.route, input.route) ||
        prior.acceptedEvent.receiptId !== input.event.receiptId
      ) {
        throw new DeviceGatewayError("workspace_dispatch_event_conflict");
      }
      if (prior.terminalEvent !== null || prior.resolution !== null) {
        if (
          prior.terminalEvent === null ||
          prior.resolution === null ||
          !sameWorkspaceDispatchJson(prior.terminalEvent, input.event) ||
          !sameWorkspaceDispatchJson(prior.resolution, input.resolution)
        ) {
          throw new DeviceGatewayError("workspace_dispatch_terminal_conflict");
        }
        return workspaceDispatchCommitResult(
          "replayed",
          prior,
          prior.terminalEvent,
        );
      }
      const now = this.#databaseNow();
      requireWorkspaceDispatchNotBefore(now, prior.updatedAt);
      const committed = parseWorkspaceDispatchAuthorityRecord({
        ...prior,
        terminalEvent: input.event,
        resolution: input.resolution,
        updatedAt: now,
      });
      this.#write(committed);
      return workspaceDispatchCommitResult("committed", committed, input.event);
    });
  }

  async load(
    executionId: string,
  ): Promise<WorkspaceDispatchAuthorityRecord | null> {
    this.#assertOpen();
    validateDeviceId(executionId);
    return this.#readTransaction(() => {
      const { kind } = requireSqliteExecutionAuthorityState(
        this.#database,
        executionId,
        "workspace_dispatch_stored_state_invalid",
      );
      const record = this.#load(executionId);
      return kind === "tool" ? null : record;
    });
  }

  async claimConnection(
    rawInput: ClaimDeviceConnectionInput,
  ): Promise<DeviceConnectionRoute> {
    this.#assertOpen();
    const input = validateClaimDeviceConnectionInput(rawInput);
    return this.#transaction(() => {
      const now = this.#databaseNow();
      const prior = this.#loadRoute(input.deviceId);
      const route = parseDeviceConnectionRoute({
        deviceId: input.deviceId,
        gatewayId: input.gatewayId,
        connectionId: input.connectionId,
        epoch: (prior?.epoch ?? 0) + 1,
        leaseExpiresAt: new Date(
          Date.parse(now) + input.leaseDurationMs,
        ).toISOString(),
        updatedAt: now,
      });
      this.#database
        .prepare(
          `INSERT INTO device_connection_routes (
             device_id, gateway_id, connection_id, epoch,
             lease_expires_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
             gateway_id = excluded.gateway_id,
             connection_id = excluded.connection_id,
             epoch = excluded.epoch,
             lease_expires_at = excluded.lease_expires_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          route.deviceId,
          route.gatewayId,
          route.connectionId,
          route.epoch,
          route.leaseExpiresAt,
          route.updatedAt,
        );
      return route;
    });
  }

  async renewConnection(
    rawInput: FenceDeviceConnectionInput &
      Readonly<{ leaseDurationMs: number }>,
  ): Promise<DeviceConnectionRoute | null> {
    this.#assertOpen();
    const input = {
      ...validateFenceDeviceConnectionInput(rawInput),
      leaseDurationMs: requireLeaseDuration(rawInput.leaseDurationMs),
    };
    return this.#transaction(() => {
      const prior = this.#loadRoute(input.deviceId);
      const now = this.#databaseNow();
      if (
        prior === null ||
        !sameDeviceConnectionRouteFence(prior, input) ||
        Date.parse(prior.leaseExpiresAt) <= Date.parse(now)
      ) {
        return null;
      }
      const renewed = parseDeviceConnectionRoute({
        ...prior,
        leaseExpiresAt: new Date(
          Date.parse(now) + input.leaseDurationMs,
        ).toISOString(),
        updatedAt: now,
      });
      this.#writeRoute(renewed);
      return renewed;
    });
  }

  async releaseConnection(
    rawInput: FenceDeviceConnectionInput,
  ): Promise<boolean> {
    this.#assertOpen();
    const input = validateFenceDeviceConnectionInput(rawInput);
    return this.#transaction(() => {
      const now = this.#databaseNow();
      return (
        this.#database
          .prepare(
            `UPDATE device_connection_routes
                SET lease_expires_at = ?, updated_at = ?
              WHERE device_id = ? AND gateway_id = ?
                AND connection_id = ? AND epoch = ?`,
          )
          .run(
            now,
            now,
            input.deviceId,
            input.gatewayId,
            input.connectionId,
            input.epoch,
          ).changes === 1
      );
    });
  }

  async loadConnection(
    deviceId: string,
  ): Promise<DeviceConnectionRoute | null> {
    this.#assertOpen();
    validateDeviceId(deviceId);
    const route = this.#loadRoute(deviceId);
    return route !== null &&
      Date.parse(route.leaseExpiresAt) > Date.parse(this.#databaseNow())
      ? route
      : null;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #requiredRecord(
    command: DeviceWorkspaceListCommand,
  ): WorkspaceDispatchAuthorityRecord {
    const { kind } = requireSqliteExecutionAuthorityState(
      this.#database,
      command.executionId,
      "workspace_dispatch_stored_state_invalid",
    );
    const record = this.#load(command.executionId);
    if (kind === "tool") {
      throw new DeviceGatewayError("device_dispatch_kind_conflict");
    }
    if (kind === null && record === null) {
      throw new DeviceGatewayError("workspace_dispatch_authority_missing");
    }
    if (kind !== "workspaceList" || record === null) {
      throw new DeviceGatewayError("workspace_dispatch_stored_state_invalid");
    }
    requireWorkspaceFingerprint(record, workspaceDispatchFingerprint(command));
    return record;
  }

  #load(executionId: string): WorkspaceDispatchAuthorityRecord | null {
    const row = this.#database
      .prepare(
        `SELECT execution_id, record_json
           FROM workspace_dispatch_records
          WHERE execution_id = ?`,
      )
      .get(executionId) as WorkspaceRow | undefined;
    if (row === undefined) return null;
    try {
      const record = parseWorkspaceDispatchAuthorityRecord(
        JSON.parse(row.record_json),
      );
      if (record.executionId !== row.execution_id) {
        throw new DeviceGatewayError("workspace_dispatch_authority_corrupt");
      }
      return record;
    } catch (error) {
      if (error instanceof DeviceGatewayError) throw error;
      throw new DeviceGatewayError("workspace_dispatch_authority_corrupt", {
        cause: error,
      });
    }
  }

  #write(record: WorkspaceDispatchAuthorityRecord): void {
    this.#database
      .prepare(
        `UPDATE workspace_dispatch_records
            SET record_json = ?
          WHERE execution_id = ?`,
      )
      .run(JSON.stringify(record), record.executionId);
  }

  #loadCurrentRoute(deviceId: string): DeviceConnectionRoute | null {
    return this.#loadRoute(deviceId);
  }

  #loadRoute(deviceId: string): DeviceConnectionRoute | null {
    const row = this.#database
      .prepare(
        `SELECT device_id, gateway_id, connection_id, epoch,
                lease_expires_at, updated_at
           FROM device_connection_routes
          WHERE device_id = ?`,
      )
      .get(deviceId) as SqliteDeviceConnectionRouteRow | undefined;
    return row === undefined ? null : routeFromSqliteRow(row);
  }

  #writeRoute(route: DeviceConnectionRoute): void {
    this.#database
      .prepare(
        `UPDATE device_connection_routes
            SET lease_expires_at = ?, updated_at = ?
          WHERE device_id = ? AND gateway_id = ?
            AND connection_id = ? AND epoch = ?`,
      )
      .run(
        route.leaseExpiresAt,
        route.updatedAt,
        route.deviceId,
        route.gatewayId,
        route.connectionId,
        route.epoch,
      );
  }

  #databaseNow(): string {
    const row = this.#database
      .prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now`)
      .get() as { now: string };
    return row.now;
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  #readTransaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DeviceGatewayError("workspace_dispatch_store_closed");
    }
  }
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original transaction failure.
  }
}
