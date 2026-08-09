import { RunStoreError, type ThreadLocator } from "@crewon/application";
import { type ModelHistoryItem } from "@crewon/domain";
import { type PoolClient } from "pg";

import {
  decodePostgresModelHistoryItem,
  safeInteger,
  type PostgresModelHistoryRow,
} from "./postgres-thread-codec.ts";

export async function loadPostgresModelHistoryValidation(
  client: PoolClient,
  schema: string,
  locator: ThreadLocator,
  appended: readonly ModelHistoryItem[],
): Promise<
  Readonly<{
    lastSequence: number;
    pendingToolCalls: readonly ModelHistoryItem[];
    existingToolCallKeys: ReadonlySet<string>;
  }>
> {
  const table = `${schema}.model_history_items`;
  const head = await client.query<{ last_sequence: string | number }>(
    `SELECT COALESCE(MAX(sequence), 0) AS last_sequence
     FROM ${table} WHERE tenant_id=$1 AND thread_id=$2`,
    [locator.tenantId, locator.threadId],
  );
  const pending = await client.query<PostgresModelHistoryRow>(
    `SELECT calls.tenant_id, calls.thread_id, calls.sequence, calls.item_id,
            calls.run_id, calls.segment_id, calls.call_id, calls.tool_kind,
            calls.item_type, calls.item_json, calls.created_at
     FROM ${table} AS calls
     WHERE calls.tenant_id=$1 AND calls.thread_id=$2
       AND calls.item_type='tool_call'
       AND NOT EXISTS (
         SELECT 1 FROM ${table} AS results
         WHERE results.thread_id=calls.thread_id
           AND results.run_id=calls.run_id
           AND results.call_id=calls.call_id
           AND results.item_type='tool_result'
       )
     ORDER BY calls.sequence ASC LIMIT 129`,
    [locator.tenantId, locator.threadId],
  );
  if (pending.rows.length > 128) {
    throw new RunStoreError("model_history_pending_tool_limit_exceeded");
  }
  const newCallIds = appended.flatMap((item) =>
    item.type === "tool_call" ? [item.callId] : [],
  );
  const existing =
    newCallIds.length === 0
      ? []
      : (
          await client.query<{ run_id: string; call_id: string }>(
            `SELECT run_id, call_id FROM ${table}
             WHERE tenant_id=$1 AND thread_id=$2
               AND item_type='tool_call' AND call_id=ANY($3::text[])`,
            [locator.tenantId, locator.threadId, newCallIds],
          )
        ).rows;
  return {
    lastSequence: safeInteger(head.rows[0]?.last_sequence ?? 0),
    pendingToolCalls: pending.rows.map((row) =>
      decodePostgresModelHistoryItem(row, locator),
    ),
    existingToolCallKeys: new Set(
      existing.map((row) => `${row.run_id}\0${row.call_id}`),
    ),
  };
}
