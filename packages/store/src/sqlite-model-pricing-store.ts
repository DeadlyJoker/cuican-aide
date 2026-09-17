import type { DatabaseSync } from "node:sqlite";
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
export function readSqliteModelPricing(
  database: DatabaseSync,
  input: ModelPricingLocator,
) {
  validateModelPricingLocator(input);
  return decodeModelPricing(
    database
      .prepare(
        "SELECT revision, CASE WHEN length(CAST(price_json AS BLOB)) <= 2048 THEN price_json ELSE '{}' END AS price_json FROM model_token_pricing WHERE tenant_id=? AND agent_version_id=?",
      )
      .get(input.tenantId, input.agentVersionId),
  );
}
export function sqliteCallPricing(
  database: DatabaseSync,
  input: ModelPricingLocator,
) {
  return modelPricingSnapshot(readSqliteModelPricing(database, input));
}
export class SqliteModelPricingStore implements ModelPricingStore {
  readonly database: DatabaseSync;
  readonly assertOpen: () => void;
  constructor(database: DatabaseSync, assertOpen: () => void) {
    this.database = database;
    this.assertOpen = assertOpen;
  }
  async get(input: ModelPricingLocator) {
    this.assertOpen();
    return readSqliteModelPricing(this.database, input);
  }
  async set(input: SetModelPricingInput) {
    this.assertOpen();
    validateModelPricingUpdate(input);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const before = readSqliteModelPricing(this.database, input),
        next = nextModelPricing(before, input);
      if (next !== before)
        this.database
          .prepare(
            "INSERT INTO model_token_pricing(tenant_id,agent_version_id,revision,price_json) VALUES(?,?,?,?) ON CONFLICT(tenant_id,agent_version_id) DO UPDATE SET revision=excluded.revision,price_json=excluded.price_json",
          )
          .run(
            input.tenantId,
            input.agentVersionId,
            next.revision,
            stableJson(next.price),
          );
      this.database.exec("COMMIT");
      return next;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
