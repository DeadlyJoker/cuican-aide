import type { PoolClient, PoolConfig } from "pg";

import { DeviceGatewayError } from "./device-gateway-error.ts";
import type { WorkspaceDispatchAuthorityRecord } from "./workspace-dispatch-authority.ts";

export type WorkspaceDispatchKind = "tool" | "workspaceList";

export async function postgresWorkspaceDatabaseNow(
  client: PoolClient,
): Promise<string> {
  const result = await client.query<{ now: string }>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`,
  );
  return result.rows[0]!.now;
}

export function requireFreshPostgresWorkspaceKind(
  kind: WorkspaceDispatchKind | null,
): void {
  if (kind === "tool") {
    throw new DeviceGatewayError("device_dispatch_kind_conflict");
  }
  if (kind === "workspaceList") {
    throw new DeviceGatewayError("workspace_dispatch_stored_state_invalid");
  }
}

export function requirePostgresWorkspaceFingerprint(
  record: WorkspaceDispatchAuthorityRecord,
  fingerprint: string,
): void {
  if (record.fingerprint !== fingerprint) {
    throw new DeviceGatewayError("workspace_dispatch_identity_conflict");
  }
}

export function requirePostgresWorkspaceExecutionState(
  kind: WorkspaceDispatchKind | null,
  toolRecord: boolean,
  workspaceRecord: boolean,
): void {
  if (
    (kind === null && (toolRecord || workspaceRecord)) ||
    (kind === "tool" && (!toolRecord || workspaceRecord)) ||
    (kind === "workspaceList" && (toolRecord || !workspaceRecord))
  ) {
    throw new DeviceGatewayError("workspace_dispatch_stored_state_invalid");
  }
}

export function requirePostgresWorkspaceExecutionId(executionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(executionId)) {
    throw new DeviceGatewayError("device_execution_id_invalid");
  }
}

export function requirePostgresWorkspaceSchema(schema: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(schema)) {
    throw new DeviceGatewayError("device_dispatch_postgres_schema_invalid");
  }
  return schema;
}

export function postgresWorkspacePoolConfig(
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
    application_name: "crewon-device-workspace-gateway",
    connectionString,
    max: maxPoolSize,
    statement_timeout: statementTimeoutMs,
  };
}

export function normalizePostgresWorkspaceError(error: unknown): Error {
  if (error instanceof DeviceGatewayError) return error;
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

export async function rollbackPostgresWorkspaceTransaction(
  client: PoolClient,
): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction failure.
  }
}
