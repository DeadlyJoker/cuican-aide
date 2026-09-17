import type { Pool, PoolClient } from "pg";
import { RunStoreError } from "@crewon/application";
import { lockPostgresCheckpointRun } from "./postgres-checkpoint-lock.ts";
import type {
  CompactionCheckpointStore,
  ReadCompactionCheckpointInput,
  SaveCompactionCheckpointInput,
} from "@crewon/application";
import {
  loadPostgresRunAttempt,
  loadPostgresRunStep,
} from "./postgres-execution-authority.ts";
import { validateModelUsageAttempt } from "./model-usage-store-support.ts";
import { normalizePostgresError } from "./postgres-store-support.ts";
import {
  checkpointDigest,
  checkpointSaveRevision,
  decodeCheckpoint,
  validateCheckpointInput,
  validateCheckpointSave,
  type CompactionCheckpointRow,
} from "./compaction-checkpoint-support.ts";
export class PostgresCompactionCheckpointStore
  implements CompactionCheckpointStore
{
  readonly pool: Pool;
  readonly schema: string;
  readonly guard: (
    client: PoolClient,
    input: ReadCompactionCheckpointInput,
  ) => Promise<void>;
  constructor(
    pool: Pool,
    schema: string,
    guard: (
      client: PoolClient,
      input: ReadCompactionCheckpointInput,
    ) => Promise<void>,
  ) {
    this.pool = pool;
    this.schema = schema;
    this.guard = guard;
  }
  async load(input: ReadCompactionCheckpointInput) {
    validateCheckpointInput(input);
    return this.within(input, "read", (client) => this.read(client, input));
  }
  async save(input: SaveCompactionCheckpointInput) {
    validateCheckpointSave(input);
    return this.within(input, "write", async (client) => {
      const next = checkpointSaveRevision(
        await this.read(client, input),
        input,
      );
      if (!next.replay)
        await client.query(
          `INSERT INTO ${this.schema}.context_compaction_checkpoints(tenant_id,run_id,step_id,context_digest,revision,payload,payload_digest) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,run_id,step_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,payload_digest=excluded.payload_digest`,
          [
            input.scope.tenantId,
            input.scope.runId,
            input.scope.stepId,
            input.contextDigest,
            next.revision,
            input.payload,
            checkpointDigest(input.payload),
          ],
        );
      return next.revision;
    });
  }
  private async read(client: PoolClient, input: ReadCompactionCheckpointInput) {
    const result = await client.query(
      `SELECT step_id,context_digest,revision,CASE WHEN octet_length(payload)<=262144 THEN payload ELSE NULL END payload,payload_digest FROM ${this.schema}.context_compaction_checkpoints WHERE tenant_id=$1 AND run_id=$2`,
      [input.scope.tenantId, input.scope.runId],
    );
    return decodeCheckpoint(
      result.rows[0] as CompactionCheckpointRow | undefined,
      input,
    );
  }
  private async within<T>(
    input: ReadCompactionCheckpointInput,
    mode: "read" | "write",
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let discardClient = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='1000ms'");
      await client.query("SET LOCAL lock_timeout='250ms'");
      await lockPostgresCheckpointRun(client, input.scope, mode);
      await this.guard(client, input);
      validateModelUsageAttempt(
        { lease: input.lease, record: input.scope },
        await loadPostgresRunAttempt(client, this.schema, input.scope),
        await loadPostgresRunStep(client, this.schema, input.scope),
      );
      const result = await action(client);
      await this.guard(client, input);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        discardClient = true;
        throw new RunStoreError("postgres_checkpoint_rollback_failed", {
          cause: rollbackError,
        });
      }
      throw normalizePostgresError(error);
    } finally {
      client.release(discardClient);
    }
  }
}
