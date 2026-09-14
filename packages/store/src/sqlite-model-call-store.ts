import type { DatabaseSync } from "node:sqlite";
import type {
  ModelUsagePageQuery,
  RecordModelCallInput,
} from "@crewon/application";
import {
  loadSqliteRunAttempt,
  loadSqliteRunStep,
} from "./sqlite-execution-authority.ts";
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
import { stableJson } from "./store-invariants.ts";

export function recordSqliteModelCall(
  database: DatabaseSync,
  input: RecordModelCallInput,
  validateLease: () => void,
): "recorded" | "enriched" | "replayed" {
  validateModelCallInput(input);
  database.exec("BEGIN IMMEDIATE");
  try {
    validateLease();
    validateModelUsageAttempt(
      input,
      loadSqliteRunAttempt(database, input.record),
      loadSqliteRunStep(database, input.record),
    );
    const key = modelCallKey(input.record);
    const prior = database
      .prepare(
        "SELECT call_order, CASE WHEN length(CAST(record_json AS BLOB)) <= 16384 THEN record_json ELSE NULL END AS record_json FROM model_call_observations WHERE call_key = ?",
      )
      .get(key);
    if (prior !== undefined) {
      const merged = mergeModelCallReplay(
        decodeModelCallEntry(prior.call_order, prior.record_json, input.record)
          .record,
        input.record,
      );
      if (merged !== null)
        database
          .prepare(
            "UPDATE model_call_observations SET record_json = ? WHERE call_key = ?",
          )
          .run(stableJson(merged), key);
      validateLease();
      database.exec("COMMIT");
      return merged === null ? "replayed" : "enriched";
    }
    validateNewModelCall(input.record);
    database
      .prepare(
        "INSERT INTO model_call_observations(call_key, tenant_id, run_id, record_json) VALUES (?, ?, ?, ?)",
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

export function listSqliteModelCalls(
  database: DatabaseSync,
  query: ModelUsagePageQuery,
) {
  validateModelUsagePage(query);
  return database
    .prepare(
      "SELECT call_order, CASE WHEN length(CAST(record_json AS BLOB)) <= 16384 THEN record_json ELSE NULL END AS record_json FROM model_call_observations WHERE tenant_id = ? AND run_id = ? AND call_order > ? ORDER BY call_order LIMIT ?",
    )
    .all(query.tenantId, query.runId, query.afterOrder, query.limit)
    .map((row) => decodeModelCallEntry(row.call_order, row.record_json, query));
}
