import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { RunStoreError, type ModelUsageEntry } from "@crewon/application";
import type { ModelCallRecord, ModelUsageRecord } from "@crewon/domain";
import {
  modelUsageLookupKey,
  modelUsageKey,
} from "./model-usage-store-support.ts";
import { decodeModelUsageIdentity } from "./model-usage-identity.ts";
import { stableJson } from "./store-invariants.ts";

export function completedCallUsage(
  prior: ModelUsageRecord,
  call: ModelCallRecord,
): ModelUsageRecord | null {
  const responseId = call.observation.providerResponseId;
  if (call.observation.outcome === "unknown" || responseId === null)
    return null;
  if (
    modelUsageLookupKey({ ...prior, identity: ["observation", "scope"] }) !==
    modelUsageLookupKey({ ...call, identity: ["observation", "scope"] })
  )
    throw new RunStoreError("model_usage_conflict");
  if (prior.observation.providerResponseId !== null) {
    if (prior.observation.providerResponseId !== responseId)
      throw new RunStoreError("model_usage_conflict");
    return null;
  }
  if (
    prior.observation.callId !== call.observation.callId ||
    prior.stepId !== call.stepId ||
    prior.attemptId !== call.attemptId
  )
    throw new RunStoreError("model_usage_conflict");
  return {
    ...prior,
    observation: { ...prior.observation, providerResponseId: responseId },
  };
}

function query(postgres: boolean, schema: string, call: ModelCallRecord) {
  const key = modelUsageLookupKey({
    ...call,
    identity: ["call", call.observation.callId],
  });
  const p = postgres ? "$1" : "?";
  const size = postgres
    ? "octet_length(u.record_json::text)"
    : "length(CAST(u.record_json AS BLOB))";
  return {
    key,
    values: postgres ? [key] : [key, key],
    sql: `WITH candidates AS (
      SELECT usage_order FROM ${schema}model_usage_observations WHERE usage_key=${p}
      UNION SELECT usage_order FROM ${schema}model_usage_call_aliases WHERE call_key=${p})
      SELECT u.usage_order,u.usage_key,CASE WHEN ${size}<=16384 THEN u.record_json ELSE NULL END AS record_json
      FROM candidates c JOIN ${schema}model_usage_observations u ON u.usage_order=c.usage_order`,
  };
}

function promoted(
  rows: Record<string, unknown>[],
  call: ModelCallRecord,
): { entry: ModelUsageEntry; record: ModelUsageRecord } | null {
  const decoded = decodeModelUsageIdentity(rows, call);
  if (decoded === null) return null;
  const record = completedCallUsage(decoded.entry.record, call);
  return record === null ? null : { entry: decoded.entry, record };
}

/** Shares the validated lease/Run transaction with the call's final accounting update. */
export function completeSqliteCallUsage(
  database: DatabaseSync,
  call: ModelCallRecord,
): void {
  if (
    call.observation.outcome === "unknown" ||
    call.observation.providerResponseId === null ||
    !call.observation.usageEventObserved
  )
    return;
  const q = query(false, "", call);
  const update = promoted(database.prepare(q.sql).all(...q.values), call);
  if (update === null) return;
  const key = modelUsageKey(update.record);
  const existing = database
    .prepare(
      "SELECT usage_order FROM model_usage_observations WHERE usage_key=?",
    )
    .get(key);
  if (
    existing !== undefined &&
    Number(existing.usage_order) !== update.entry.order
  )
    throw new RunStoreError("model_usage_conflict");
  database
    .prepare(
      "UPDATE model_usage_observations SET usage_key=?,record_json=? WHERE usage_order=?",
    )
    .run(key, stableJson(update.record), update.entry.order);
  database
    .prepare(
      "INSERT INTO model_usage_call_aliases(call_key,usage_order) VALUES (?,?) ON CONFLICT(call_key) DO NOTHING",
    )
    .run(q.key, update.entry.order);
}

export async function completePostgresCallUsage(
  client: PoolClient,
  schema: string,
  call: ModelCallRecord,
): Promise<void> {
  if (
    call.observation.outcome === "unknown" ||
    call.observation.providerResponseId === null ||
    !call.observation.usageEventObserved
  )
    return;
  const q = query(true, schema, call);
  const update = promoted((await client.query(q.sql, q.values)).rows, call);
  if (update === null) return;
  const key = modelUsageKey(update.record);
  const existing = await client.query(
    `SELECT usage_order FROM ${schema}model_usage_observations WHERE usage_key=$1`,
    [key],
  );
  if (
    existing.rows[0] !== undefined &&
    Number(existing.rows[0].usage_order) !== update.entry.order
  )
    throw new RunStoreError("model_usage_conflict");
  await client.query(
    `UPDATE ${schema}model_usage_observations SET usage_key=$1,record_json=$2 WHERE usage_order=$3`,
    [key, stableJson(update.record), update.entry.order],
  );
  await client.query(
    `INSERT INTO ${schema}model_usage_call_aliases(call_key,usage_order) VALUES ($1,$2) ON CONFLICT(call_key) DO NOTHING`,
    [q.key, update.entry.order],
  );
}
