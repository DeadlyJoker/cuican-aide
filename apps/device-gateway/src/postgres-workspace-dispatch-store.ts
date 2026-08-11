import {
  parseDeviceWorkspaceListCommand,
  type DeviceWorkspaceListCommand,
} from "@crewon/contracts";
import { Pool, type PoolClient } from "pg";

import { DeviceGatewayError } from "./device-gateway-error.ts";
import {
  PostgresDeviceDispatchStore,
  type PostgresDeviceDispatchStoreOptions,
} from "./postgres-device-dispatch-store.ts";
import {
  normalizePostgresWorkspaceError,
  postgresWorkspaceDatabaseNow,
  postgresWorkspacePoolConfig,
  requireFreshPostgresWorkspaceKind,
  requirePostgresWorkspaceExecutionId,
  requirePostgresWorkspaceExecutionState,
  requirePostgresWorkspaceFingerprint,
  requirePostgresWorkspaceSchema,
  rollbackPostgresWorkspaceTransaction,
  type WorkspaceDispatchKind,
} from "./postgres-workspace-dispatch-support.ts";
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

const DEFAULT_SCHEMA = "crewon_device_gateway";

type WorkspaceRow = Readonly<{
  execution_id: string;
  record_json: unknown;
}>;
type RouteRow = Readonly<{
  device_id: string;
  gateway_id: string;
  connection_id: string;
  epoch: string | number;
  lease_expires_at: string;
}>;

export class PostgresWorkspaceDispatchStore
  implements WorkspaceDispatchStorePort
{
  readonly #pool: Pool;
  readonly #ownsPool: boolean;
  readonly #schema: string;
  readonly #schemaAuthority: PostgresDeviceDispatchStore;
  readonly #ready: Promise<void>;
  #closed = false;

  constructor(options: PostgresDeviceDispatchStoreOptions) {
    if (
      (options.pool === undefined) ===
      (options.connectionString === undefined)
    ) {
      throw new DeviceGatewayError("device_dispatch_postgres_config_invalid");
    }
    this.#schema = requirePostgresWorkspaceSchema(
      options.schema ?? DEFAULT_SCHEMA,
    );
    if (options.pool !== undefined) {
      this.#pool = options.pool;
      this.#ownsPool = false;
    } else {
      this.#pool = new Pool(
        postgresWorkspacePoolConfig(
          options.connectionString as string,
          options.maxPoolSize,
          options.statementTimeoutMs,
        ),
      );
      this.#ownsPool = true;
    }
    this.#schemaAuthority = new PostgresDeviceDispatchStore({
      pool: this.#pool,
      schema: this.#schema,
    });
    this.#ready = this.#schemaAuthority.ready();
  }

  async ready(): Promise<void> {
    this.#assertOpen();
    await this.#ready;
  }

  async prepare(
    input: DeviceWorkspaceListCommand,
    preparedAt: string,
  ): Promise<PrepareWorkspaceDispatchResult> {
    this.#assertOpen();
    await this.#ready;
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
    return this.#writeTransaction(async (client) => {
      await this.#lockExecution(client, candidate.executionId);
      const kind = await this.#loadKind(client, candidate.executionId);
      const prior = await this.#load(client, candidate.executionId, true);
      const toolRecord = await this.#toolRecordExists(
        client,
        candidate.executionId,
        true,
      );
      requirePostgresWorkspaceExecutionState(kind, toolRecord, prior !== null);
      if (prior !== null) {
        if (kind !== "workspaceList") {
          throw new DeviceGatewayError(
            "workspace_dispatch_stored_state_invalid",
          );
        }
        requirePostgresWorkspaceFingerprint(prior, fingerprint);
        return { outcome: "existing", record: prior };
      }
      requireFreshPostgresWorkspaceKind(kind);
      await client.query(
        `INSERT INTO ${this.#schema}.device_execution_kinds (
           execution_id, command_kind
         ) VALUES ($1, 'workspaceList')`,
        [candidate.executionId],
      );
      await client.query(
        `INSERT INTO ${this.#schema}.workspace_dispatch_records (
           execution_id, record_json
         ) VALUES ($1, $2::jsonb)`,
        [candidate.executionId, JSON.stringify(candidate)],
      );
      return { outcome: "created", record: candidate };
    });
  }

  async acceptEvent(
    rawInput: AcceptWorkspaceDispatchEventInput,
  ): Promise<CommitWorkspaceDispatchEventResult> {
    this.#assertOpen();
    await this.#ready;
    const input = validateAcceptWorkspaceDispatchEventInput(rawInput);
    const committed = await this.#writeTransaction(async (client) => {
      await this.#lockExecution(client, input.command.executionId);
      const prior = await this.#requiredRecord(client, input.command);
      if (prior.acceptedEvent !== null) {
        if (
          prior.route === null ||
          !sameWorkspaceDispatchRouteFence(prior.route, input.route) ||
          !sameWorkspaceDispatchJson(prior.acceptedEvent, input.event)
        ) {
          throw new DeviceGatewayError("workspace_dispatch_event_conflict");
        }
        return { outcome: "replayed" as const, record: prior };
      }
      const currentRoute = await this.#loadCurrentRoute(
        client,
        input.command.deviceId,
      );
      if (currentRoute === null) {
        throw new DeviceGatewayError("workspace_dispatch_route_unavailable");
      }
      const expected = parseWorkspaceDispatchRoute(input.route);
      const authoritative = parseWorkspaceDispatchRoute({
        deviceId: currentRoute.device_id,
        gatewayId: currentRoute.gateway_id,
        connectionId: currentRoute.connection_id,
        connectionEpoch: Number(currentRoute.epoch),
        leaseExpiresAt: currentRoute.lease_expires_at,
      });
      if (!sameWorkspaceDispatchRouteFence(expected, authoritative)) {
        throw new DeviceGatewayError("workspace_dispatch_route_stale");
      }
      const now = await postgresWorkspaceDatabaseNow(client);
      if (Date.parse(now) >= Date.parse(authoritative.leaseExpiresAt)) {
        throw new DeviceGatewayError("workspace_dispatch_route_expired");
      }
      requireWorkspaceDispatchNotBefore(now, prior.updatedAt);
      const record = parseWorkspaceDispatchAuthorityRecord({
        ...prior,
        route: authoritative,
        acceptedEvent: input.event,
        updatedAt: now,
      });
      await this.#write(client, record);
      return { outcome: "committed" as const, record };
    });
    return workspaceDispatchCommitResult(
      committed.outcome,
      committed.record,
      committed.record.acceptedEvent!,
    );
  }

  async settleEvent(
    rawInput: SettleWorkspaceDispatchEventInput,
  ): Promise<CommitWorkspaceDispatchEventResult> {
    this.#assertOpen();
    await this.#ready;
    const input = validateSettleWorkspaceDispatchEventInput(rawInput);
    const committed = await this.#writeTransaction(async (client) => {
      await this.#lockExecution(client, input.command.executionId);
      const prior = await this.#requiredRecord(client, input.command);
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
        return { outcome: "replayed" as const, record: prior };
      }
      const now = await postgresWorkspaceDatabaseNow(client);
      requireWorkspaceDispatchNotBefore(now, prior.updatedAt);
      const record = parseWorkspaceDispatchAuthorityRecord({
        ...prior,
        terminalEvent: input.event,
        resolution: input.resolution,
        updatedAt: now,
      });
      await this.#write(client, record);
      return { outcome: "committed" as const, record };
    });
    return workspaceDispatchCommitResult(
      committed.outcome,
      committed.record,
      committed.record.terminalEvent!,
    );
  }

  async load(
    executionId: string,
  ): Promise<WorkspaceDispatchAuthorityRecord | null> {
    this.#assertOpen();
    await this.#ready;
    requirePostgresWorkspaceExecutionId(executionId);
    try {
      const client = await this.#pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const kind = await this.#loadKind(client, executionId, false);
        const record = await this.#load(client, executionId);
        const toolRecord = await this.#toolRecordExists(client, executionId);
        requirePostgresWorkspaceExecutionState(
          kind,
          toolRecord,
          record !== null,
        );
        await client.query("COMMIT");
        if (kind === "tool") return null;
        return record;
      } catch (error) {
        await rollbackPostgresWorkspaceTransaction(client);
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      throw normalizePostgresWorkspaceError(error);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#ready;
      await this.#schemaAuthority.close();
    } finally {
      if (this.#ownsPool) await this.#pool.end();
    }
  }

  async #requiredRecord(
    client: PoolClient,
    command: DeviceWorkspaceListCommand,
  ): Promise<WorkspaceDispatchAuthorityRecord> {
    const kind = await this.#loadKind(client, command.executionId);
    const record = await this.#load(client, command.executionId, true);
    const toolRecord = await this.#toolRecordExists(
      client,
      command.executionId,
      true,
    );
    requirePostgresWorkspaceExecutionState(kind, toolRecord, record !== null);
    if (kind === "tool") {
      throw new DeviceGatewayError("device_dispatch_kind_conflict");
    }
    if (kind === null && record === null) {
      throw new DeviceGatewayError("workspace_dispatch_authority_missing");
    }
    if (kind !== "workspaceList" || record === null) {
      throw new DeviceGatewayError("workspace_dispatch_stored_state_invalid");
    }
    requirePostgresWorkspaceFingerprint(
      record,
      workspaceDispatchFingerprint(command),
    );
    return record;
  }

  async #loadKind(
    queryable: Pick<PoolClient, "query">,
    executionId: string,
    forUpdate = true,
  ): Promise<WorkspaceDispatchKind | null> {
    const result = await queryable.query<{ command_kind: string }>(
      `SELECT command_kind
         FROM ${this.#schema}.device_execution_kinds
        WHERE execution_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [executionId],
    );
    const kind = result.rows[0]?.command_kind;
    if (kind === undefined) return null;
    if (kind !== "tool" && kind !== "workspaceList") {
      throw new DeviceGatewayError("workspace_dispatch_stored_state_invalid");
    }
    return kind;
  }

  async #load(
    queryable: Pick<PoolClient, "query">,
    executionId: string,
    forUpdate = false,
  ): Promise<WorkspaceDispatchAuthorityRecord | null> {
    const result = await queryable.query<WorkspaceRow>(
      `SELECT execution_id, record_json
         FROM ${this.#schema}.workspace_dispatch_records
        WHERE execution_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [executionId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const record = parseWorkspaceDispatchAuthorityRecord(row.record_json);
    if (record.executionId !== row.execution_id) {
      throw new DeviceGatewayError("workspace_dispatch_authority_corrupt");
    }
    return record;
  }

  async #loadCurrentRoute(
    client: PoolClient,
    deviceId: string,
  ): Promise<RouteRow | null> {
    const result = await client.query<RouteRow>(
      `SELECT device_id, gateway_id, connection_id, epoch,
              to_char(lease_expires_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS lease_expires_at
         FROM ${this.#schema}.device_connection_routes
        WHERE device_id = $1
        FOR UPDATE`,
      [deviceId],
    );
    return result.rows[0] ?? null;
  }

  async #toolRecordExists(
    queryable: Pick<PoolClient, "query">,
    executionId: string,
    forUpdate = false,
  ): Promise<boolean> {
    const result = await queryable.query(
      `SELECT execution_id
         FROM ${this.#schema}.device_dispatch_records
        WHERE execution_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [executionId],
    );
    return result.rows[0] !== undefined;
  }

  async #write(
    client: PoolClient,
    record: WorkspaceDispatchAuthorityRecord,
  ): Promise<void> {
    await client.query(
      `UPDATE ${this.#schema}.workspace_dispatch_records
          SET record_json = $1::jsonb
        WHERE execution_id = $2`,
      [JSON.stringify(record), record.executionId],
    );
  }

  async #lockExecution(client: PoolClient, executionId: string): Promise<void> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`device-dispatch:${this.#schema}:${executionId}`],
    );
  }

  async #writeTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect().catch((error: unknown) => {
      throw normalizePostgresWorkspaceError(error);
    });
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackPostgresWorkspaceTransaction(client);
      throw normalizePostgresWorkspaceError(error);
    } finally {
      client.release();
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DeviceGatewayError("workspace_dispatch_store_closed");
    }
  }
}
