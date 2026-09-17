import type { Pool, PoolClient } from "pg";
import {
  modelPricingSnapshot,
  type ModelPricingLocator,
  type ModelPricingStore,
  type SetModelPricingInput,
} from "@crewon/application";
import {
  decodeModelPricing,
  nextModelPricing,
  validateModelPricingLocator,
  validateModelPricingUpdate,
} from "./model-pricing-store-support.ts";
import { stableJson } from "./store-invariants.ts";
import {
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";
export async function readPostgresModelPricing(
  client: Pick<PoolClient, "query">,
  schema: string,
  input: ModelPricingLocator,
) {
  validateModelPricingLocator(input);
  const rows = await client.query(
    `SELECT revision, CASE WHEN octet_length(price_json::text)<=2048 THEN price_json ELSE '{}'::jsonb END AS price_json FROM ${schema}.model_token_pricing WHERE tenant_id=$1 AND agent_version_id=$2`,
    [input.tenantId, input.agentVersionId],
  );
  return decodeModelPricing(rows.rows[0]);
}
export async function postgresCallPricing(
  client: PoolClient,
  schema: string,
  input: ModelPricingLocator,
) {
  return modelPricingSnapshot(
    await readPostgresModelPricing(client, schema, input),
  );
}
export class PostgresModelPricingStore implements ModelPricingStore {
  readonly pool: Pool;
  readonly schema: string;
  readonly assertOpen: () => void;
  constructor(pool: Pool, schema: string, assertOpen: () => void) {
    this.pool = pool;
    this.schema = schema;
    this.assertOpen = assertOpen;
  }
  async get(input: ModelPricingLocator) {
    this.assertOpen();
    try {
      return await readPostgresModelPricing(this.pool, this.schema, input);
    } catch (e) {
      throw normalizePostgresError(e);
    }
  }
  async set(input: SetModelPricingInput) {
    this.assertOpen();
    validateModelPricingUpdate(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [stableJson(["model-pricing", input.tenantId, input.agentVersionId])],
      );
      const before = await readPostgresModelPricing(client, this.schema, input),
        next = nextModelPricing(before, input);
      if (next !== before)
        await client.query(
          `INSERT INTO ${this.schema}.model_token_pricing(tenant_id,agent_version_id,revision,price_json) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,agent_version_id) DO UPDATE SET revision=excluded.revision,price_json=excluded.price_json`,
          [
            input.tenantId,
            input.agentVersionId,
            next.revision,
            stableJson(next.price),
          ],
        );
      await client.query("COMMIT");
      return next;
    } catch (e) {
      await rollbackPostgres(client);
      throw normalizePostgresError(e);
    } finally {
      client.release();
    }
  }
}
