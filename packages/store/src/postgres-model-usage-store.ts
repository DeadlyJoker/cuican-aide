import { settlePostgresModelSpending } from "./postgres-model-spending-store.ts";
import { postgresUsageGeneration } from "./model-generation-response-store.ts";
import {
  preserveUsageGeneration,
  assertUsageGenerationReplay,
  needsUsageGenerationCheck,
} from "./model-usage-generation.ts";
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
import {
  decodeModelUsageIdentity,
  modelUsageIdentityQuery,
} from "./model-usage-identity.ts";

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
      const identity = modelUsageIdentityQuery(
        true,
        `${this.schemaSql}.`,
        input.record,
      );
      const { key, callKey } = identity;
      const prior = decodeModelUsageIdentity(
        (await client.query(identity.sql, identity.values)).rows,
        input.record,
      );
      const alias = async (order: number) => {
        if (callKey !== null)
          await client.query(
            `INSERT INTO ${this.schemaSql}.model_usage_call_aliases(call_key,usage_order) VALUES ($1,$2) ON CONFLICT(call_key) DO NOTHING`,
            [callKey, order],
          );
      };
      if (prior !== null) {
        if (
          needsUsageGenerationCheck(
            prior.entry.record,
            input.record,
            prior.verifiedCallAlias,
          )
        )
          assertUsageGenerationReplay(
            prior.entry.record,
            await postgresUsageGeneration(
              client,
              `${this.schemaSql}.`,
              input.record,
            ),
          );
        const merged = mergeModelUsageReplay(
          prior.entry.record,
          input.record,
          prior,
        );
        if (merged !== null)
          await client.query(
            `UPDATE ${this.schemaSql}.model_usage_observations SET record_json=$1, usage_key=$2 WHERE usage_order=$3`,
            [stableJson(merged), modelUsageKey(merged), prior.entry.order],
          );
        await alias(prior.entry.order);
        await settlePostgresModelSpending(
          client,
          this.schemaSql,
          merged ?? prior.entry.record,
        );
        await this.validateLease(client, input);
        await client.query("COMMIT");
        return merged === null ? "replayed" : "enriched";
      }
      const record = preserveUsageGeneration(
        input.record,
        await postgresUsageGeneration(
          client,
          `${this.schemaSql}.`,
          input.record,
        ),
      );
      const inserted = await client.query(
        `INSERT INTO ${this.schemaSql}.model_usage_observations(usage_key, tenant_id, run_id, record_json) VALUES ($1,$2,$3,$4) RETURNING usage_order`,
        [key, input.record.tenantId, input.record.runId, stableJson(record)],
      );
      await alias(Number(inserted.rows[0].usage_order));
      await settlePostgresModelSpending(client, this.schemaSql, record);
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
