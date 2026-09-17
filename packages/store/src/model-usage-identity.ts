import { RunStoreError, type ModelUsageEntry } from "@crewon/application";
import type { ModelUsageRecord } from "@crewon/domain";
import { accountingCallIdentity } from "./model-accounting-index.ts";
import {
  decodeModelUsageEntry,
  modelUsageKey,
  modelUsageLookupKey,
} from "./model-usage-store-support.ts";

export function modelUsageCallKey(record: ModelUsageRecord): string | null {
  const callId = record.observation.callId;
  return callId === undefined
    ? null
    : modelUsageLookupKey({ ...record, identity: ["call", callId] });
}

/** At most one primary-key row, one alias and two legacy call matches; no history scan/backfill. */
export function modelUsageIdentityQuery(
  postgres: boolean,
  schema: string,
  record: ModelUsageRecord,
) {
  const values: (string | number | null)[] = [];
  const bind = (value: string | number | null) => {
    values.push(value);
    return postgres ? `$${values.length}` : "?";
  };
  const table = `${schema}model_usage_observations`,
    aliases = `${schema}model_usage_call_aliases`;
  const key = modelUsageKey(record),
    callKey = modelUsageCallKey(record);
  const main = `SELECT usage_order FROM ${table} WHERE usage_key=${bind(key)}`;
  const alias = `SELECT usage_order FROM ${aliases} WHERE call_key=${bind(callKey)}`;
  const legacy = `SELECT usage_order FROM ${table} ${postgres ? "" : "INDEXED BY model_usage_call_identity"}
    WHERE tenant_id=${bind(record.tenantId)} AND run_id=${bind(record.runId)}
    AND ${accountingCallIdentity(postgres)}=${bind(record.observation.callId ?? null)}
    AND NOT EXISTS (SELECT 1 FROM ${aliases} WHERE call_key=${bind(callKey)})
    ORDER BY usage_order LIMIT 2`;
  const size = postgres
    ? "octet_length(u.record_json::text)"
    : "length(CAST(u.record_json AS BLOB))";
  const sql = `WITH candidates AS (${main} UNION ${alias} UNION SELECT usage_order FROM (${legacy}) legacy)
    SELECT u.usage_order,u.usage_key,CASE WHEN ${size}<=16384 THEN u.record_json ELSE NULL END AS record_json,
    EXISTS (SELECT 1 FROM ${aliases} a WHERE a.call_key=${bind(callKey)} AND a.usage_order=u.usage_order) AS matched_alias
    FROM candidates c JOIN ${table} u ON u.usage_order=c.usage_order ORDER BY u.usage_order`;
  return { sql, values, key, callKey };
}

export function decodeModelUsageIdentity(
  rows: Record<string, unknown>[],
  record: Pick<ModelUsageRecord, "tenantId" | "runId">,
): {
  entry: ModelUsageEntry;
  verifiedCallAlias: boolean;
} | null {
  if (rows.length > 1) throw new RunStoreError("model_usage_conflict");
  const row = rows[0];
  if (row === undefined) return null;
  const entry = decodeModelUsageEntry(row.usage_order, row.record_json, record);
  if (modelUsageKey(entry.record) !== row.usage_key)
    throw new RunStoreError("model_usage_conflict");
  return {
    entry,
    verifiedCallAlias: row.matched_alias === true || row.matched_alias === 1,
  };
}
