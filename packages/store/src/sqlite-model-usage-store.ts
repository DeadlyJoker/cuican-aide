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
    const key = modelUsageKey(input.record);
    const prior = database
      .prepare(
        "SELECT usage_order, record_json FROM model_usage_observations WHERE usage_key = ?",
      )
      .get(key);
    if (prior !== undefined) {
      const merged = mergeModelUsageReplay(
        decodeModelUsageEntry(
          prior.usage_order,
          prior.record_json,
          input.record,
        ).record,
        input.record,
      );
      if (merged !== null)
        database
          .prepare(
            "UPDATE model_usage_observations SET record_json = ? WHERE usage_key = ?",
          )
          .run(stableJson(merged), key);
      validateLease();
      database.exec("COMMIT");
      return merged === null ? "replayed" : "enriched";
    }
    database
      .prepare(
        "INSERT INTO model_usage_observations(usage_key, tenant_id, run_id, record_json) VALUES (?, ?, ?, ?)",
      )
      .run(
        key,
        input.record.tenantId,
        input.record.runId,
        stableJson(input.record),
      );
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
