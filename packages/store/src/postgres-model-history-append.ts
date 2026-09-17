import {
  RunStoreError,
  type ModelHistoryAppend,
  type ThreadLocator,
} from "@crewon/application";
import type { PoolClient } from "pg";
import {
  historyToolCallKey,
  validateModelHistoryIncrementalPairing,
  type ModelHistoryAppendState,
  type StoredHistoryToolCall,
} from "./model-history-append-validation.ts";
import { loadPostgresLegacyHistoryPending } from "./postgres-model-history.ts";
import { safeInteger } from "./postgres-thread-codec.ts";
import {
  stableJson,
  validateModelHistoryAppendShape,
} from "./store-invariants.ts";

/** The owner holds the Thread write lock. Cold legacy validation is performed once per valid metadata lifetime. */
async function ensureAppendState(
  client: PoolClient,
  schema: string,
  locator: ThreadLocator,
): Promise<Omit<ModelHistoryAppendState, "referencedToolCalls">> {
  const head = await client.query<{
    last_sequence: string;
    stored_sequence: string | null;
    pending_count: string | null;
  }>(
    `
    SELECT head.last_sequence, state.last_sequence AS stored_sequence, state.pending_tool_call_count AS pending_count
    FROM (SELECT COALESCE(MAX(sequence),0) AS last_sequence FROM ${schema}.model_history_items WHERE tenant_id=$1 AND thread_id=$2) AS head
    LEFT JOIN ${schema}.model_history_append_state AS state ON state.tenant_id=$1 AND state.thread_id=$2`,
    [locator.tenantId, locator.threadId],
  );
  const row = head.rows[0]!;
  const lastSequence = safeInteger(row.last_sequence);
  if (row.stored_sequence !== null) {
    if (safeInteger(row.stored_sequence) !== lastSequence)
      throw new RunStoreError("model_history_append_state_stale");
    return {
      lastSequence,
      pendingToolCallCount: safeInteger(row.pending_count!),
    };
  }
  // Preserve full validation of at most 128 legacy pending call bodies. Warm appends
  // never retrieve historical bodies or enumerate completed/pending tool ledgers.
  const pendingToolCallCount =
    lastSequence === 0
      ? 0
      : (await loadPostgresLegacyHistoryPending(client, schema, locator))
          .length;
  if (lastSequence > 0) await validateStoredPairing(client, schema, locator);
  await client.query(
    `INSERT INTO ${schema}.model_history_append_state (tenant_id, thread_id, last_sequence, pending_tool_call_count)
    SELECT $1,$2,$3,$4 WHERE EXISTS (SELECT 1 FROM ${schema}.threads WHERE tenant_id=$1 AND thread_id=$2)`,
    [locator.tenantId, locator.threadId, lastSequence, pendingToolCallCount],
  );
  return { lastSequence, pendingToolCallCount };
}

async function validateStoredPairing(
  client: PoolClient,
  schema: string,
  locator: ThreadLocator,
): Promise<void> {
  const values = [locator.tenantId, locator.threadId];
  const orphan = await client.query(
    `SELECT 1 FROM ${schema}.model_history_items AS results
    LEFT JOIN LATERAL (SELECT sequence, segment_id, tool_kind FROM ${schema}.model_history_items AS candidate
      WHERE candidate.tenant_id=$1 AND candidate.thread_id=$2 AND candidate.run_id=results.run_id
        AND candidate.call_id=results.call_id AND candidate.item_type='tool_call' LIMIT 1) AS calls ON true
    WHERE results.tenant_id=$1 AND results.thread_id=$2 AND results.item_type='tool_result'
      AND (calls.sequence IS NULL OR calls.sequence>=results.sequence OR calls.segment_id IS DISTINCT FROM results.segment_id
        OR calls.tool_kind IS DISTINCT FROM results.tool_kind) LIMIT 1`,
    values,
  );
  if (orphan.rows.length)
    throw new RunStoreError("model_history_tool_result_orphaned");
  const interrupted = await client.query(
    `SELECT 1 FROM ${schema}.model_history_items AS calls
    LEFT JOIN LATERAL (SELECT sequence FROM ${schema}.model_history_items AS candidate
      WHERE candidate.tenant_id=$1 AND candidate.thread_id=$2 AND candidate.run_id=calls.run_id
        AND candidate.call_id=calls.call_id AND candidate.item_type='tool_result' LIMIT 1) AS results ON true
    WHERE calls.tenant_id=$1 AND calls.thread_id=$2 AND calls.item_type='tool_call'
      AND EXISTS (SELECT 1 FROM ${schema}.model_history_items AS boundary WHERE boundary.tenant_id=calls.tenant_id AND boundary.thread_id=calls.thread_id
        AND boundary.item_type NOT IN ('tool_call','tool_result') AND boundary.sequence>calls.sequence
        AND boundary.sequence<COALESCE(results.sequence,9223372036854775807)) LIMIT 1`,
    values,
  );
  if (interrupted.rows.length)
    throw new RunStoreError("model_history_tool_result_missing");
}

/** Warm validation reads only scalar metadata and identities referenced by this append. */
export async function validatePostgresModelHistoryAppend(
  client: PoolClient,
  schema: string,
  locator: ThreadLocator,
  append: ModelHistoryAppend,
  itemIdExists: (id: string) => boolean,
): Promise<void> {
  const state = await ensureAppendState(client, schema, locator);
  if (state.pendingToolCallCount > 128)
    throw new RunStoreError("model_history_pending_tool_limit_exceeded");
  validateModelHistoryAppendShape(
    append,
    locator,
    state.lastSequence,
    itemIdExists,
  );
  const requested = new Map<string, { run_id: string; call_id: string }>();
  for (const item of append.items) {
    if (item.type !== "tool_call" && item.type !== "tool_result") continue;
    requested.set(historyToolCallKey(item.runId, item.callId), {
      run_id: item.runId!,
      call_id: item.callId,
    });
  }
  const referencedToolCalls = new Map<string, StoredHistoryToolCall>();
  if (requested.size) {
    const matches = await client.query<{
      run_id: string;
      call_id: string;
      segment_id: string;
      tool_kind: "function" | "custom";
      completed: boolean;
    }>(
      `
      SELECT calls.run_id, calls.call_id, calls.segment_id, calls.tool_kind,
        EXISTS (SELECT 1 FROM ${schema}.model_history_items AS results WHERE results.tenant_id=calls.tenant_id AND results.thread_id=calls.thread_id
          AND results.run_id=calls.run_id AND results.call_id=calls.call_id AND results.item_type='tool_result') AS completed
      FROM jsonb_to_recordset($3::jsonb) AS requested(run_id text, call_id text)
      JOIN ${schema}.model_history_items AS calls ON calls.run_id=requested.run_id AND calls.call_id=requested.call_id
      WHERE calls.tenant_id=$1 AND calls.thread_id=$2 AND calls.item_type='tool_call'`,
      [locator.tenantId, locator.threadId, stableJson([...requested.values()])],
    );
    for (const row of matches.rows) {
      if (
        !row.segment_id ||
        (row.tool_kind !== "function" && row.tool_kind !== "custom")
      )
        throw new RunStoreError("model_history_append_state_invalid");
      referencedToolCalls.set(historyToolCallKey(row.run_id, row.call_id), {
        runId: row.run_id,
        callId: row.call_id,
        segmentId: row.segment_id,
        kind: row.tool_kind,
        completed: row.completed,
      });
    }
  }
  validateModelHistoryIncrementalPairing(append.items, {
    ...state,
    referencedToolCalls,
  });
}
