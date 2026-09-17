import { sqliteUsageGeneration } from "./model-generation-response-store.ts";
import { settleSqliteModelSpending } from "./sqlite-model-spending-store.ts";
import {
  preserveUsageGeneration,
  assertUsageGenerationReplay,
  needsUsageGenerationCheck,
} from "./model-usage-generation.ts";
import type { DatabaseSync } from "node:sqlite";
import type {
  ModelUsagePageQuery,
  RecordModelUsageInput,
} from "@crewon/application";
import {
  loadSqliteRunAttempt,
  loadSqliteRunStep,
} from "./sqlite-execution-authority.ts";
import {
  decodeModelUsageEntry,
  modelUsageKey,
  validateModelUsageAttempt,
  validateModelUsageInput,
  validateModelUsagePage,
  mergeModelUsageReplay,
} from "./model-usage-store-support.ts";
import { stableJson } from "./store-invariants.ts";
import {
  decodeModelUsageIdentity,
  modelUsageIdentityQuery,
} from "./model-usage-identity.ts";

export function recordSqliteModelUsage(
  database: DatabaseSync,
  input: RecordModelUsageInput,
  validateLease: () => void,
): "recorded" | "enriched" | "replayed" {
  validateModelUsageInput(input);
  database.exec("BEGIN IMMEDIATE");
  try {
    validateLease();
    validateModelUsageAttempt(
      input,
      loadSqliteRunAttempt(database, input.record),
      loadSqliteRunStep(database, input.record),
    );
    const identity = modelUsageIdentityQuery(false, "", input.record);
    const { key, callKey } = identity;
    const prior = decodeModelUsageIdentity(
      database.prepare(identity.sql).all(...identity.values),
      input.record,
    );
    const alias = (order: number) => {
      if (callKey !== null)
        database
          .prepare(
            "INSERT INTO model_usage_call_aliases(call_key,usage_order) VALUES (?,?) ON CONFLICT(call_key) DO NOTHING",
          )
          .run(callKey, order);
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
          sqliteUsageGeneration(database, input.record),
        );
      const merged = mergeModelUsageReplay(
        prior.entry.record,
        input.record,
        prior,
      );
      if (merged !== null)
        database
          .prepare(
            "UPDATE model_usage_observations SET record_json = ?, usage_key = ? WHERE usage_order = ?",
          )
          .run(stableJson(merged), modelUsageKey(merged), prior.entry.order);
      alias(prior.entry.order);
      settleSqliteModelSpending(database, merged ?? prior.entry.record);
      validateLease();
      database.exec("COMMIT");
      return merged === null ? "replayed" : "enriched";
    }
    const record = preserveUsageGeneration(
      input.record,
      sqliteUsageGeneration(database, input.record),
    );
    const inserted = database
      .prepare(
        "INSERT INTO model_usage_observations(usage_key, tenant_id, run_id, record_json) VALUES (?, ?, ?, ?)",
      )
      .run(key, input.record.tenantId, input.record.runId, stableJson(record));
    alias(Number(inserted.lastInsertRowid));
    settleSqliteModelSpending(database, record);
    validateLease();
    database.exec("COMMIT");
    return "recorded";
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function listSqliteModelUsage(
  database: DatabaseSync,
  query: ModelUsagePageQuery,
) {
  validateModelUsagePage(query);
  return database
    .prepare(
      "SELECT usage_order, record_json FROM model_usage_observations WHERE tenant_id = ? AND run_id = ? AND usage_order > ? ORDER BY usage_order LIMIT ?",
    )
    .all(query.tenantId, query.runId, query.afterOrder, query.limit)
    .map((row) =>
      decodeModelUsageEntry(row.usage_order, row.record_json, query),
    );
}
