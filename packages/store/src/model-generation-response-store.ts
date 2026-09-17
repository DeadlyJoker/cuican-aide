import { RunStoreError } from "@crewon/application";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { ModelCallRecord, ModelUsageRecord } from "@crewon/domain";
import {
  decodeModelCallEntry,
  modelCallKey,
} from "./model-call-store-support.ts";
import {
  generationResponseKey,
  usageGeneration,
  usageGenerationLookup,
} from "./model-usage-generation.ts";

/** Two fixed-size digests per generated response; ambiguous identities never choose an owner. */
export function generationResponseLinkSql(
  postgres: boolean,
  schema: string,
): string {
  const p = postgres ? ["$1", "$2"] : ["?", "?"];
  return `INSERT INTO ${schema}model_generation_responses(response_key,call_key,ambiguous) VALUES (${p[0]},${p[1]},0)
    ON CONFLICT(response_key) DO UPDATE SET ambiguous=1
    WHERE model_generation_responses.call_key<>excluded.call_key AND model_generation_responses.ambiguous=0`;
}
export function linkSqliteGenerationResponse(
  db: DatabaseSync,
  call: ModelCallRecord,
): void {
  const key = generationResponseKey(call);
  if (key !== null)
    db.prepare(generationResponseLinkSql(false, "")).run(
      key,
      modelCallKey(call),
    );
}
export async function linkPostgresGenerationResponse(
  client: PoolClient,
  schema: string,
  call: ModelCallRecord,
): Promise<void> {
  const key = generationResponseKey(call);
  if (key !== null)
    await client.query(generationResponseLinkSql(true, schema), [
      key,
      modelCallKey(call),
    ]);
}

export function generationCallQuery(
  postgres: boolean,
  schema: string,
  byResponse: boolean,
): string {
  const size = postgres
    ? "octet_length(c.record_json::text)"
    : "length(CAST(c.record_json AS BLOB))";
  const p = postgres ? "$1" : "?";
  return `SELECT c.call_key,c.call_order,CASE WHEN ${size}<=16384 THEN c.record_json ELSE NULL END AS record_json FROM ${schema}model_call_observations c
    ${byResponse ? `JOIN ${schema}model_generation_responses g ON g.call_key=c.call_key WHERE g.response_key=${p} AND g.ambiguous=0` : `WHERE c.call_key=${p}`}`;
}
function decode(
  row: Record<string, unknown> | undefined,
  record: ModelUsageRecord,
): ModelCallRecord | null {
  if (row === undefined) return null;
  const call = decodeModelCallEntry(
    row.call_order,
    row.record_json,
    record,
  ).record;
  if (modelCallKey(call) !== row.call_key)
    throw new RunStoreError("model_usage_generation_conflict");
  return call;
}
export function sqliteUsageGeneration(
  db: DatabaseSync,
  record: ModelUsageRecord,
): ModelUsageRecord["generation"] {
  if (record.observation.callId === undefined) return undefined;
  const direct = decode(
    db.prepare(generationCallQuery(false, "", false)).get(
      modelCallKey({
        ...record,
        observation: { callId: record.observation.callId },
      }),
    ),
    record,
  );
  const lookup = usageGenerationLookup(record, direct);
  if (lookup.kind === "unknown") return undefined;
  if (lookup.kind === "generate") return usageGeneration(record, lookup.call);
  return usageGeneration(
    record,
    decode(
      db.prepare(generationCallQuery(false, "", true)).get(lookup.responseKey),
      record,
    ),
    lookup.responseKey,
  );
}
export async function postgresUsageGeneration(
  client: PoolClient,
  schema: string,
  record: ModelUsageRecord,
): Promise<ModelUsageRecord["generation"]> {
  if (record.observation.callId === undefined) return undefined;
  const direct = decode(
    (
      await client.query(generationCallQuery(true, schema, false), [
        modelCallKey({
          ...record,
          observation: { callId: record.observation.callId },
        }),
      ])
    ).rows[0],
    record,
  );
  const lookup = usageGenerationLookup(record, direct);
  if (lookup.kind === "unknown") return undefined;
  if (lookup.kind === "generate") return usageGeneration(record, lookup.call);
  return usageGeneration(
    record,
    decode(
      (
        await client.query(generationCallQuery(true, schema, true), [
          lookup.responseKey,
        ])
      ).rows[0],
      record,
    ),
    lookup.responseKey,
  );
}
