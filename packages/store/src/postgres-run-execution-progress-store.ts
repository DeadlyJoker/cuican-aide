import type { Pool, PoolClient } from "pg";
import { lockPostgresCheckpointRun } from "./postgres-checkpoint-lock.ts";
import {
  RunStoreError,
  type RunExecutionProgressStore,
  type ReadRunExecutionProgressInput,
  type SaveRunExecutionProgressInput,
} from "@crewon/application";
import { normalizePostgresError } from "./postgres-store-support.ts";
import {
  decodeRunExecutionProgress,
  progressSaveIsReplay,
  runExecutionProgressDigest,
  validateRunExecutionProgressRead,
  validateRunExecutionProgressSave,
  type RunExecutionProgressRow,
} from "./run-execution-progress-support.ts";
export class PostgresRunExecutionProgressStore
  implements RunExecutionProgressStore
{
  readonly pool: Pool;
  readonly schema: string;
  readonly guard: (
    client: PoolClient,
    input: ReadRunExecutionProgressInput,
  ) => Promise<void>;
  constructor(
    pool: Pool,
    schema: string,
    guard: (
      client: PoolClient,
      input: ReadRunExecutionProgressInput,
    ) => Promise<void>,
  ) {
    this.pool = pool;
    this.schema = schema;
    this.guard = guard;
  }
  async load(input: ReadRunExecutionProgressInput) {
    validateRunExecutionProgressRead(input);
    return this.within(input, "read", (client) => this.read(client, input));
  }
  async save(input: SaveRunExecutionProgressInput) {
    validateRunExecutionProgressSave(input);
    await this.within(input, "write", async (client) => {
      if (progressSaveIsReplay(await this.read(client, input), input)) return;
      const cp = input.checkpoint;
      const anchor = await client.query(
        `SELECT event_id FROM ${this.schema}.run_events WHERE tenant_id=$1 AND run_id=$2 AND sequence=$3`,
        [input.scope.tenantId, input.scope.runId, cp.throughSequence],
      );
      if (anchor.rows[0]?.event_id !== cp.sourceEventId)
        throw new RunStoreError("run_execution_progress_anchor_mismatch");
      await client.query(
        `INSERT INTO ${this.schema}.run_execution_progress(tenant_id,run_id,through_sequence,source_event_id,payload,payload_digest) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT(tenant_id,run_id) DO UPDATE SET through_sequence=excluded.through_sequence,source_event_id=excluded.source_event_id,payload=excluded.payload,payload_digest=excluded.payload_digest`,
        [
          input.scope.tenantId,
          input.scope.runId,
          cp.throughSequence,
          cp.sourceEventId,
          cp.payload,
          runExecutionProgressDigest(cp),
        ],
      );
    });
  }
  async resetForCancellation(input: ReadRunExecutionProgressInput) {
    validateRunExecutionProgressRead(input);
    if (input.purpose !== "cancel")
      throw new RunStoreError(
        "run_execution_progress_reset_requires_cancellation",
      );
    await this.within(input, "write", async (client) => {
      await client.query(
        `DELETE FROM ${this.schema}.run_execution_progress WHERE tenant_id=$1 AND run_id=$2`,
        [input.scope.tenantId, input.scope.runId],
      );
    });
  }
  private async read(client: PoolClient, input: ReadRunExecutionProgressInput) {
    const rows = await client.query(
      `SELECT p.through_sequence,p.source_event_id,CASE WHEN octet_length(p.payload)<=262144 THEN p.payload ELSE NULL END payload,p.payload_digest,e.event_id anchor_id
      FROM ${this.schema}.run_execution_progress p LEFT JOIN ${this.schema}.run_events e ON e.tenant_id=p.tenant_id AND e.run_id=p.run_id AND e.sequence=p.through_sequence WHERE p.tenant_id=$1 AND p.run_id=$2`,
      [input.scope.tenantId, input.scope.runId],
    );
    return decodeRunExecutionProgress(
      rows.rows[0] as RunExecutionProgressRow | undefined,
    );
  }
  private async within<T>(
    input: ReadRunExecutionProgressInput,
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
