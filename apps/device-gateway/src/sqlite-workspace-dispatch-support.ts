import {
  parseDeviceConnectionRoute,
  type DeviceConnectionRoute,
  type FenceDeviceConnectionInput,
} from "./device-connection-route-store.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import {
  parseWorkspaceDispatchRoute,
  type WorkspaceDispatchAuthorityRecord,
} from "./workspace-dispatch-authority.ts";

export type WorkspaceDispatchKind = "tool" | "workspaceList";

export type SqliteExecutionAuthorityState = Readonly<{
  kind: WorkspaceDispatchKind | null;
  toolRecord: boolean;
  workspaceRecord: boolean;
}>;

export type SqliteDeviceConnectionRouteRow = Readonly<{
  device_id: string;
  gateway_id: string;
  connection_id: string;
  epoch: number;
  lease_expires_at: string;
  updated_at: string;
}>;

export function routeFromSqliteRow(
  row: SqliteDeviceConnectionRouteRow,
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

export function workspaceRouteFromDeviceConnectionRoute(
  route: DeviceConnectionRoute,
) {
  return parseWorkspaceDispatchRoute({
    deviceId: route.deviceId,
    gatewayId: route.gatewayId,
    connectionId: route.connectionId,
    connectionEpoch: route.epoch,
    leaseExpiresAt: route.leaseExpiresAt,
  });
}

export function sameDeviceConnectionRouteFence(
  route: DeviceConnectionRoute,
  fence: FenceDeviceConnectionInput,
): boolean {
  return (
    route.deviceId === fence.deviceId &&
    route.gatewayId === fence.gatewayId &&
    route.connectionId === fence.connectionId &&
    route.epoch === fence.epoch
  );
}

export function requireFreshWorkspaceKind(
  kind: WorkspaceDispatchKind | null,
): void {
  if (kind === "tool") {
    throw new DeviceGatewayError("device_dispatch_kind_conflict");
  }
  if (kind === "workspaceList") {
    throw new DeviceGatewayError("workspace_dispatch_stored_state_invalid");
  }
}

export function requireWorkspaceFingerprint(
  record: WorkspaceDispatchAuthorityRecord,
  fingerprint: string,
): void {
  if (record.fingerprint !== fingerprint) {
    throw new DeviceGatewayError("workspace_dispatch_identity_conflict");
  }
}

export function requireSqliteExecutionAuthorityState(
  database: DatabaseSync,
  executionId: string,
  errorCode:
    | "device_dispatch_stored_state_invalid"
    | "workspace_dispatch_stored_state_invalid" = "device_dispatch_stored_state_invalid",
): SqliteExecutionAuthorityState {
  const kindRow = database
    .prepare(
      "SELECT command_kind FROM device_execution_kinds WHERE execution_id = ?",
    )
    .get(executionId) as { command_kind: string } | undefined;
  const kind = kindRow?.command_kind ?? null;
  const toolRecord = hasRecord(
    database,
    "device_dispatch_records",
    executionId,
  );
  const workspaceRecord = hasRecord(
    database,
    "workspace_dispatch_records",
    executionId,
  );
  if (
    (kind !== null && kind !== "tool" && kind !== "workspaceList") ||
    (kind === null && (toolRecord || workspaceRecord)) ||
    (kind === "tool" && (!toolRecord || workspaceRecord)) ||
    (kind === "workspaceList" && (toolRecord || !workspaceRecord))
  ) {
    throw new DeviceGatewayError(errorCode);
  }
  return { kind, toolRecord, workspaceRecord };
}

function hasRecord(
  database: DatabaseSync,
  table: "device_dispatch_records" | "workspace_dispatch_records",
  executionId: string,
): boolean {
  return (
    database
      .prepare(`SELECT 1 AS present FROM ${table} WHERE execution_id = ?`)
      .get(executionId) !== undefined
  );
}
import type { DatabaseSync } from "node:sqlite";
