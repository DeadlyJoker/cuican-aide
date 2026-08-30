import { RunStoreError } from "@crewon/application";
import { RunLifecycleError, ThreadLifecycleError } from "@crewon/domain";
import { Pool, type PoolClient, type PoolConfig } from "pg";

export type PostgresConnectionOptions = Readonly<{
  connectionString?: string;
  pool?: Pool;
  maxPoolSize?: number;
  statementTimeoutMs?: number;
}>;

export function createPostgresPool(
  options: PostgresConnectionOptions,
  applicationName: string,
): Readonly<{ pool: Pool; ownsPool: boolean }> {
  if (
    (options.pool === undefined) ===
    (options.connectionString === undefined)
  ) {
    throw new RunStoreError("postgres_connection_config_invalid");
  }
  if (options.pool !== undefined) {
    return { pool: options.pool, ownsPool: false };
  }
  return {
    pool: new Pool(
      postgresPoolConfig(
        options.connectionString as string,
        applicationName,
        options.maxPoolSize,
        options.statementTimeoutMs,
      ),
    ),
    ownsPool: true,
  };
}

export async function rollbackPostgres(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction failure.
  }
}

export async function assertPostgresSchemaNotNewer(
  client: PoolClient,
  schema: string,
  component: string,
  supportedVersion: number,
): Promise<void> {
  const registry = await client.query<{ present: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [`${schema}.schema_migrations`],
  );
  if (registry.rows[0]?.present !== true) return;
  const result = await client.query<{ version: number }>(
    `SELECT version FROM ${schema}.schema_migrations WHERE component=$1`,
    [component],
  );
  const version = result.rows[0]?.version;
  if (version !== undefined && version > supportedVersion) {
    throw new RunStoreError("postgres_schema_too_new");
  }
}

export function normalizePostgresError(error: unknown): Error {
  if (
    error instanceof RunStoreError ||
    error instanceof RunLifecycleError ||
    error instanceof ThreadLifecycleError
  ) {
    return error;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (code === "40001" || code === "40P01") {
    return new RunStoreError("postgres_retryable", { cause: error });
  }
  if (code.startsWith("23")) {
    return new RunStoreError("postgres_constraint", { cause: error });
  }
  return new RunStoreError("postgres_error", {
    cause: error instanceof Error ? error : undefined,
  });
}

function postgresPoolConfig(
  connectionString: string,
  applicationName: string,
  maxPoolSize = 10,
  statementTimeoutMs = 30_000,
): PoolConfig {
  if (connectionString.trim().length === 0) {
    throw new RunStoreError("postgres_connection_config_invalid");
  }
  if (
    !Number.isSafeInteger(maxPoolSize) ||
    maxPoolSize < 1 ||
    maxPoolSize > 100
  ) {
    throw new RunStoreError("postgres_pool_size_invalid");
  }
  if (
    !Number.isSafeInteger(statementTimeoutMs) ||
    statementTimeoutMs < 1 ||
    statementTimeoutMs > 300_000
  ) {
    throw new RunStoreError("postgres_statement_timeout_invalid");
  }
  return {
    application_name: applicationName,
    connectionString,
    max: maxPoolSize,
    statement_timeout: statementTimeoutMs,
  };
}
