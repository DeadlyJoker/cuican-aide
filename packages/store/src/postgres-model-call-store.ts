import type { Pool, PoolClient } from "pg";
import type {
  ModelCallEntry,
  ModelUsagePageQuery,
  RecordModelCallInput,
} from "@crewon/application";
import {
  loadPostgresRunAttempt,
  loadPostgresRunStep,
} from "./postgres-execution-authority.ts";
import {
  decodeModelCallEntry,
  modelCallKey,
  validateNewModelCall,
  validateModelCallInput,
  mergeModelCallReplay,
} from "./model-call-store-support.ts";
import {
  validateModelUsageAttempt,
  validateModelUsagePage,
} from "./model-usage-store-support.ts";
import {
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";
import { stableJson } from "./store-invariants.ts";

export class PostgresModelCallStore {
  readonly pool: Pool;
  readonly schemaSql: string;
  readonly validateLease: (
    client: PoolClient,
    input: RecordModelCallInput,
  ) => Promise<void>;
  constructor(
    pool: Pool,
    schemaSql: string,
    validateLease: (
      client: PoolClient,
      input: RecordModelCallInput,
    ) => Promise<void>,
  ) {
    this.pool = pool;
    this.schemaSql = schemaSql;
    this.validateLease = validateLease;
  }

  async recordModelCall(
    input: RecordModelCallInput,
  ): Promise<"recorded" | "enriched" | "replayed"> {
    validateModelCallInput(input);
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
      const key = modelCallKey(input.record);
      const prior = await client.query(
        `SELECT call_order, CASE WHEN octet_length(record_json::text) <= 16384 THEN record_json ELSE NULL END AS record_json FROM ${this.schemaSql}.model_call_observations WHERE call_key=$1`,
        [key],
      );
      if (prior.rows[0] !== undefined) {
        const merged = mergeModelCallReplay(
          decodeModelCallEntry(
            prior.rows[0].call_order,
            prior.rows[0].record_json,
            input.record,
          ).record,
          input.record,
        );
        if (merged !== null)
          await client.query(
            `UPDATE ${this.schemaSql}.model_call_observations SET record_json=$1 WHERE call_key=$2`,
            [stableJson(merged), key],
          );
        await this.validateLease(client, input);
        await client.query("COMMIT");
        return merged === null ? "replayed" : "enriched";
      }
      validateNewModelCall(input.record);
      await client.query(
        `INSERT INTO ${this.schemaSql}.model_call_observations(call_key, tenant_id, run_id, record_json) VALUES ($1,$2,$3,$4)`,
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

  async listModelCalls(
    query: ModelUsagePageQuery,
  ): Promise<readonly ModelCallEntry[]> {
    validateModelUsagePage(query);
    try {
      const result = await this.pool.query(
        `SELECT call_order, CASE WHEN octet_length(record_json::text) <= 16384 THEN record_json ELSE NULL END AS record_json FROM ${this.schemaSql}.model_call_observations WHERE tenant_id=$1 AND run_id=$2 AND call_order>$3 ORDER BY call_order LIMIT $4`,
        [query.tenantId, query.runId, query.afterOrder, query.limit],
      );
      return result.rows.map((row) =>
        decodeModelCallEntry(row.call_order, row.record_json, query),
      );
    } catch (error) {
      throw normalizePostgresError(error);
    }
  }
}
