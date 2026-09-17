import { RunStoreError, type ThreadLocator } from "@crewon/application";
import { type ModelHistoryItem } from "@crewon/domain";
import { type PoolClient } from "pg";

import {
  decodePostgresModelHistoryItem,
  type PostgresModelHistoryRow,
} from "./postgres-thread-codec.ts";

export async function loadPostgresLegacyHistoryPending(
  client: PoolClient,
  schema: string,
  locator: ThreadLocator,
): Promise<readonly ModelHistoryItem[]> {
  const table = `${schema}.model_history_items`;
  const pending = await client.query<PostgresModelHistoryRow>(
    `SELECT calls.tenant_id, calls.thread_id, calls.sequence, calls.item_id,
            calls.run_id, calls.segment_id, calls.call_id, calls.tool_kind,
            calls.item_type, calls.item_json, calls.created_at
     FROM ${table} AS calls
     LEFT JOIN LATERAL (
       SELECT sequence FROM ${table} AS candidate
       WHERE candidate.tenant_id=$1 AND candidate.thread_id=$2
         AND candidate.run_id=calls.run_id AND candidate.call_id=calls.call_id
         AND candidate.item_type='tool_result' LIMIT 1
     ) AS completed ON true
     WHERE calls.tenant_id=$1 AND calls.thread_id=$2
       AND calls.item_type='tool_call'
       AND completed.sequence IS NULL
     ORDER BY calls.sequence ASC LIMIT 129`,
    [locator.tenantId, locator.threadId],
  );
  if (pending.rows.length > 128) {
    throw new RunStoreError("model_history_pending_tool_limit_exceeded");
  }
  return pending.rows.map((row) =>
    decodePostgresModelHistoryItem(row, locator),
  );
}
