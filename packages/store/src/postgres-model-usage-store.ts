import type { Pool, PoolClient } from "pg";
import type {
  ModelUsageEntry,
  ModelUsagePageQuery,
  RecordModelUsageInput,
} from "@crewon/application";
import {
  loadPostgresRunAttempt,
  loadPostgresRunStep,
} from "./postgres-execution-authority.ts";
import {
  decodeModelUsageEntry,
  modelUsageKey,
  validateModelUsageAttempt,
  validateModelUsageInput,
  validateModelUsagePage,
  mergeModelUsageReplay,
} from "./model-usage-store-support.ts";
import {
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";
import { stableJson } from "./store-invariants.ts";

export class PostgresModelUsageStore {
  readonly pool: Pool;
  readonly schemaSql: string;
  readonly validateLease: (
    client: PoolClient,
    input: RecordModelUsageInput,
  ) => Promise<void>;
  constructor(
    pool: Pool,
    schemaSql: string,
    validateLease: (
      client: PoolClient,
      input: RecordModelUsageInput,
    ) => Promise<void>,
  ) {
    this.pool = pool;
    this.schemaSql = schemaSql;
    this.validateLease = validateLease;
  }

  async recordModelUsage(
    input: RecordModelUsageInput,
  ): Promise<"recorded" | "enriched" | "replayed"> {
    validateModelUsageInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`run:${input.record.tenantId}:${input.record.runId}`],
      );
      await this.validateLease(client, input);
      validateModelUsageAttempt(
        input,
        await loadPostgresRunAttempt(client, this.schemaSql, input.record),
        await loadPostgresRunStep(client, this.schemaSql, input.record),
      );
      const key = modelUsageKey(input.record);
      const prior = await client.query(
        `SELECT usage_order, record_json FROM ${this.schemaSql}.model_usage_observations WHERE usage_key=$1`,
        [key],
      );
      if (prior.rows[0] !== undefined) {
        const merged = mergeModelUsageReplay(
          decodeModelUsageEntry(
            prior.rows[0].usage_order,
            prior.rows[0].record_json,
            input.record,
          ).record,
          input.record,
        );
        if (merged !== null)
          await client.query(
            `UPDATE ${this.schemaSql}.model_usage_observations SET record_json=$1 WHERE usage_key=$2`,
            [stableJson(merged), key],
          );
        await this.validateLease(client, input);
        await client.query("COMMIT");
        return merged === null ? "replayed" : "enriched";
      }
      await client.query(
        `INSERT INTO ${this.schemaSql}.model_usage_observations(usage_key, tenant_id, run_id, record_json) VALUES ($1,$2,$3,$4)`,
        [
          key,
          input.record.tenantId,
          input.record.runId,
          stableJson(input.record),
        ],
      );
      await this.validateLease(client, input);
      await client.query("COMMIT");
      return "recorded";
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }

  async listModelUsage(
    query: ModelUsagePageQuery,
  ): Promise<readonly ModelUsageEntry[]> {
    validateModelUsagePage(query);
    try {
      const result = await this.pool.query(
        `SELECT usage_order, record_json FROM ${this.schemaSql}.model_usage_observations WHERE tenant_id=$1 AND run_id=$2 AND usage_order>$3 ORDER BY usage_order LIMIT $4`,
        [query.tenantId, query.runId, query.afterOrder, query.limit],
      );
      return result.rows.map((row) =>
        decodeModelUsageEntry(row.usage_order, row.record_json, query),
      );
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }
}
