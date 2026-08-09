import {
  RunStoreError,
  type DurableQueueStore,
  type OutboxClaim,
  type OutboxLeaseInput,
  type OutboxMessage,
  type OutboxRetryInput,
  type QueueClaimInput,
  type QueueLease,
  type WorkItemClaim,
  type WorkItemLeaseInput,
  type WorkItem,
  type WorkItemRenewInput,
  type WorkItemRetryInput,
} from "@crewon/application";
import { type Pool, type PoolClient } from "pg";

import {
  validateLimit,
  validateQueueClaim,
  validateQueueLease,
  validateQueueRetry,
} from "./store-invariants.ts";
import {
  decodePostgresLease,
  decodePostgresOutbox,
  decodePostgresWorkItem,
  postgresDate,
  postgresLeaseEpoch,
  type PostgresQueueItemRow,
} from "./postgres-queue-codec.ts";
import {
  POSTGRES_QUEUE_SCHEMA_VERSION,
  postgresQueueSchemaSql,
  quotePostgresIdentifier,
  validatePostgresSchemaName,
} from "./postgres-queue-schema.ts";
import {
  assertPostgresSchemaNotNewer,
  createPostgresPool,
  normalizePostgresError,
  rollbackPostgres,
  type PostgresConnectionOptions,
} from "./postgres-store-support.ts";

export type PostgresQueueStoreOptions = PostgresConnectionOptions &
  Readonly<{ schema?: string }>;

type QueueKind = "outbox" | "work_items";
type QueueMetadataRow = Readonly<{
  status: string;
  lease_owner_id: string | null;
  lease_id: string | null;
  lease_epoch: string | number;
  lease_expires_at: Date | string | null;
  database_now: Date | string;
}>;

/** PostgreSQL-owned durable queue using database time and lease epoch fencing. */
export class PostgresQueueStore implements DurableQueueStore {
  readonly #pool: Pool;
  readonly #ownsPool: boolean;
  readonly #schema: string;
  #closed = false;

  constructor(options: PostgresQueueStoreOptions) {
    this.#schema = validatePostgresSchemaName(options.schema ?? "crewon");
    const connection = createPostgresPool(options, "crewon-store");
    this.#ownsPool = connection.ownsPool;
    this.#pool = connection.pool;
  }

  async migrate(): Promise<void> {
    this.#assertOpen();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `crewon:${this.#schema}:durable-queue`,
      ]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.#schemaSql()}`);
      await assertPostgresSchemaNotNewer(
        client,
        this.#schemaSql(),
        "durable_queue",
        POSTGRES_QUEUE_SCHEMA_VERSION,
      );
      await client.query(postgresQueueSchemaSql(this.#schemaSql()));
      const version = await client.query<{ version: number }>(
        `SELECT version
         FROM ${this.#schemaSql()}.schema_migrations
         WHERE component = 'durable_queue'`,
      );
      const stored = version.rows[0]?.version;
      if (stored !== POSTGRES_QUEUE_SCHEMA_VERSION) {
        throw new RunStoreError(
          stored !== undefined && stored > POSTGRES_QUEUE_SCHEMA_VERSION
            ? "postgres_schema_too_new"
            : "postgres_schema_version_unsupported",
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ownsPool) await this.#pool.end();
  }

  async listPendingOutbox(limit: number): Promise<readonly OutboxMessage[]> {
    return this.#listPending("outbox", limit).then((rows) =>
      rows.map(decodePostgresOutbox),
    );
  }

  async claimNextOutbox(input: QueueClaimInput): Promise<OutboxClaim | null> {
    const row = await this.#claimNext("outbox", input);
    return row === null
      ? null
      : {
          message: decodePostgresOutbox(row),
          lease: decodePostgresLease(row, input),
        };
  }

  async acknowledgeOutbox(input: OutboxLeaseInput): Promise<void> {
    validateQueueLease(input, input.messageId, "outbox_message_id_invalid");
    await this.#mutateLeased(
      "outbox",
      input.messageId,
      input,
      async (client) => {
        await expectOne(
          client.query(
            `UPDATE ${this.#tableSql("outbox")}
           SET status = 'delivered', lease_owner_id = NULL, lease_id = NULL,
               lease_expires_at = NULL, delivered_at = clock_timestamp()
           WHERE message_id = $1 AND lease_expires_at > clock_timestamp()`,
            [input.messageId],
          ),
          "queue_settlement_conflict",
        );
      },
    );
  }

  async retryOutbox(input: OutboxRetryInput): Promise<void> {
    validateQueueLease(input, input.messageId, "outbox_message_id_invalid");
    validateQueueRetry(input);
    await this.#retry("outbox", input.messageId, input);
  }

  async listPendingWorkItems(limit: number): Promise<readonly WorkItem[]> {
    return this.#listPending("work_items", limit).then((rows) =>
      rows.map(decodePostgresWorkItem),
    );
  }

  async claimNextWorkItem(
    input: QueueClaimInput,
  ): Promise<WorkItemClaim | null> {
    const row = await this.#claimNext("work_items", input);
    return row === null
      ? null
      : {
          workItem: decodePostgresWorkItem(row),
          lease: decodePostgresLease(row, input),
        };
  }

  async renewWorkItemLease(input: WorkItemRenewInput): Promise<QueueLease> {
    validateQueueClaim(input);
    validateQueueLease(input, input.workItemId, "work_item_id_invalid");
    return this.#mutateLeased(
      "work_items",
      input.workItemId,
      input,
      async (client) => {
        const updated = await client.query<{ lease_expires_at: Date | string }>(
          `UPDATE ${this.#tableSql("work_items")}
           SET lease_expires_at = clock_timestamp() + $2 * interval '1 millisecond'
           WHERE work_item_id = $1 AND lease_expires_at > clock_timestamp()
           RETURNING lease_expires_at`,
          [input.workItemId, input.leaseDurationMs],
        );
        const expiresAt = requiredRow(
          updated.rows[0],
          "queue_renewal_conflict",
        );
        return {
          ownerId: input.ownerId,
          leaseId: input.leaseId,
          epoch: input.leaseEpoch,
          expiresAt: postgresDate(expiresAt.lease_expires_at).toISOString(),
        };
      },
    );
  }

  async completeWorkItem(input: WorkItemLeaseInput): Promise<void> {
    validateQueueLease(input, input.workItemId, "work_item_id_invalid");
    await this.#mutateLeased(
      "work_items",
      input.workItemId,
      input,
      async (client) => {
        await expectOne(
          client.query(
            `UPDATE ${this.#tableSql("work_items")}
             SET status = 'completed', lease_owner_id = NULL, lease_id = NULL,
                 lease_expires_at = NULL, completed_at = clock_timestamp()
             WHERE work_item_id = $1 AND lease_expires_at > clock_timestamp()`,
            [input.workItemId],
          ),
          "queue_settlement_conflict",
        );
      },
    );
  }

  async retryWorkItem(input: WorkItemRetryInput): Promise<void> {
    validateQueueLease(input, input.workItemId, "work_item_id_invalid");
    validateQueueRetry(input);
    await this.#retry("work_items", input.workItemId, input);
  }

  async #listPending(
    kind: QueueKind,
    limit: number,
  ): Promise<PostgresQueueItemRow[]> {
    this.#assertOpen();
    validateLimit(limit);
    try {
      const result = await this.#pool.query<PostgresQueueItemRow>(
        `SELECT tenant_id, run_id, ${kind === "outbox" ? "topic" : "kind"},
                ${itemColumn(kind)} AS item_json, created_at
         FROM ${this.#tableSql(kind)}
         WHERE (status = 'pending' AND available_at <= clock_timestamp())
            OR (status = 'leased' AND lease_expires_at <= clock_timestamp())
         ORDER BY ${orderColumn(kind)} ASC
         LIMIT $1`,
        [limit],
      );
      return result.rows;
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async #claimNext(
    kind: QueueKind,
    input: QueueClaimInput,
  ): Promise<PostgresQueueItemRow | null> {
    this.#assertOpen();
    validateQueueClaim(input);
    const id = idColumn(kind);
    try {
      const result = await this.#pool.query<PostgresQueueItemRow>(
        `WITH candidate AS (
           SELECT ${id}
           FROM ${this.#tableSql(kind)}
           WHERE (status = 'pending' AND available_at <= clock_timestamp())
              OR (status = 'leased' AND lease_expires_at <= clock_timestamp())
           ORDER BY ${orderColumn(kind)} ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE ${this.#tableSql(kind)} AS queue
         SET status = 'leased', lease_owner_id = $1, lease_id = $2,
             lease_epoch = queue.lease_epoch + 1,
             lease_expires_at = clock_timestamp() + $3 * interval '1 millisecond',
             attempt_count = queue.attempt_count + 1
         FROM candidate
         WHERE queue.${id} = candidate.${id}
         RETURNING queue.tenant_id, queue.run_id,
           ${kind === "outbox" ? "queue.topic" : "queue.kind"},
           queue.${itemColumn(kind)} AS item_json, queue.created_at,
           queue.lease_epoch, queue.lease_expires_at`,
        [input.ownerId, input.leaseId, input.leaseDurationMs],
      );
      return result.rows[0] ?? null;
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }

  async #retry(
    kind: QueueKind,
    itemId: string,
    input: OutboxRetryInput | WorkItemRetryInput,
  ): Promise<void> {
    await this.#mutateLeased(kind, itemId, input, async (client) => {
      await expectOne(
        client.query(
          `UPDATE ${this.#tableSql(kind)}
           SET status = 'pending', available_at = clock_timestamp() + $2 * interval '1 millisecond',
               lease_owner_id = NULL, lease_id = NULL, lease_expires_at = NULL,
               last_error_code = $3
           WHERE ${idColumn(kind)} = $1 AND lease_expires_at > clock_timestamp()`,
          [itemId, input.retryAfterMs, input.reasonCode],
        ),
        "queue_retry_conflict",
      );
    });
  }

  async #mutateLeased<T>(
    kind: QueueKind,
    itemId: string,
    input: { ownerId: string; leaseId: string; leaseEpoch: number },
    mutation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    this.#assertOpen();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<QueueMetadataRow>(
        `SELECT status, lease_owner_id, lease_id, lease_epoch, lease_expires_at,
                clock_timestamp() AS database_now
         FROM ${this.#tableSql(kind)}
         WHERE ${idColumn(kind)} = $1
         FOR UPDATE`,
        [itemId],
      );
      validateDatabaseLease(
        requiredRow(result.rows[0], "queue_item_not_found"),
        input,
        settledStatus(kind),
      );
      const output = await mutation(client);
      await client.query("COMMIT");
      return output;
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  #schemaSql(): string {
    return quotePostgresIdentifier(this.#schema);
  }

  #tableSql(kind: QueueKind): string {
    return `${this.#schemaSql()}."${kind}"`;
  }

  #assertOpen(): void {
    if (this.#closed) throw new RunStoreError("store_closed");
  }
}

function validateDatabaseLease(
  row: QueueMetadataRow,
  input: { ownerId: string; leaseId: string; leaseEpoch: number },
  settled: string,
): void {
  if (row.status === settled)
    throw new RunStoreError("queue_item_already_settled");
  if (
    row.status !== "leased" ||
    row.lease_owner_id !== input.ownerId ||
    row.lease_id !== input.leaseId ||
    postgresLeaseEpoch(row.lease_epoch) !== input.leaseEpoch
  ) {
    throw new RunStoreError("stale_lease");
  }
  if (
    row.lease_expires_at === null ||
    postgresDate(row.lease_expires_at).getTime() <=
      postgresDate(row.database_now).getTime()
  ) {
    throw new RunStoreError("lease_expired");
  }
}

function idColumn(kind: QueueKind): string {
  return kind === "outbox" ? "message_id" : "work_item_id";
}
function itemColumn(kind: QueueKind): string {
  return kind === "outbox" ? "message_json" : "work_item_json";
}
function orderColumn(kind: QueueKind): string {
  return kind === "outbox" ? "outbox_order" : "work_item_order";
}
function settledStatus(kind: QueueKind): string {
  return kind === "outbox" ? "delivered" : "completed";
}

function requiredRow<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new RunStoreError(code);
  return value;
}

async function expectOne(
  result: Promise<{ rowCount: number | null }>,
  code: string,
): Promise<void> {
  if ((await result).rowCount !== 1) throw new RunStoreError(code);
}
