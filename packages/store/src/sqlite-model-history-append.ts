import type { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  type ModelHistoryAppend,
  type ThreadLocator,
} from "@crewon/application";
import {
  historyToolCallKey,
  validateModelHistoryIncrementalPairing,
  type ModelHistoryAppendState,
  type StoredHistoryToolCall,
} from "./model-history-append-validation.ts";
import { validateModelHistoryAppendShape } from "./store-invariants.ts";

/** Must run inside the owner's write transaction. No history bodies leave SQLite. */
export function ensureSqliteModelHistoryAppendState(
  database: DatabaseSync,
  locator: ThreadLocator,
): Omit<ModelHistoryAppendState, "referencedToolCalls"> {
  const lastSequence = Number(
    database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS value FROM model_history_items WHERE tenant_id=? AND thread_id=?",
      )
      .get(locator.tenantId, locator.threadId)?.value,
  );
  const existing = database
    .prepare(
      "SELECT last_sequence, pending_tool_call_count FROM model_history_append_state WHERE tenant_id=? AND thread_id=?",
    )
    .get(locator.tenantId, locator.threadId);
  if (existing !== undefined) {
    if (Number(existing.last_sequence) !== lastSequence)
      throw new RunStoreError("model_history_append_state_stale");
    return {
      lastSequence,
      pendingToolCallCount: Number(existing.pending_tool_call_count),
    };
  }
  // Old Threads are initialized lazily. These counts use compact partial indexes;
  // the first append validates old pairing once without returning history bodies to JS.
  validateStoredPairing(database, locator);
  const count = (type: "tool_call" | "tool_result") =>
    Number(
      database
        .prepare(
          `SELECT COUNT(*) AS value FROM model_history_items WHERE tenant_id=? AND thread_id=? AND item_type='${type}'`,
        )
        .get(locator.tenantId, locator.threadId)?.value,
    );
  const pendingToolCallCount = count("tool_call") - count("tool_result");
  if (!Number.isSafeInteger(pendingToolCallCount) || pendingToolCallCount < 0)
    throw new RunStoreError("model_history_append_state_invalid");
  database
    .prepare(
      `INSERT INTO model_history_append_state (tenant_id, thread_id, last_sequence, pending_tool_call_count)
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM threads WHERE tenant_id=? AND thread_id=?)`,
    )
    .run(
      locator.tenantId,
      locator.threadId,
      lastSequence,
      pendingToolCallCount,
      locator.tenantId,
      locator.threadId,
    );
  return { lastSequence, pendingToolCallCount };
}

function validateStoredPairing(
  database: DatabaseSync,
  locator: ThreadLocator,
): void {
  const orphan = database
    .prepare(
      `SELECT 1 FROM model_history_items AS results
    LEFT JOIN model_history_items AS calls ON calls.tenant_id=results.tenant_id AND calls.thread_id=results.thread_id
      AND calls.run_id=results.run_id AND calls.item_type='tool_call'
      AND json_extract(calls.item_json, '$.callId')=json_extract(results.item_json, '$.callId')
    WHERE results.tenant_id=? AND results.thread_id=? AND results.item_type='tool_result'
      AND (calls.sequence IS NULL OR calls.sequence>=results.sequence OR calls.segment_id IS NOT results.segment_id
        OR json_extract(calls.item_json, '$.kind') IS NOT json_extract(results.item_json, '$.kind')) LIMIT 1`,
    )
    .get(locator.tenantId, locator.threadId);
  if (orphan !== undefined)
    throw new RunStoreError("model_history_tool_result_orphaned");
  const interrupted = database
    .prepare(
      `SELECT 1 FROM model_history_items AS calls
    LEFT JOIN model_history_items AS results ON results.tenant_id=calls.tenant_id AND results.thread_id=calls.thread_id
      AND results.run_id=calls.run_id AND results.item_type='tool_result'
      AND json_extract(results.item_json, '$.callId')=json_extract(calls.item_json, '$.callId')
    WHERE calls.tenant_id=? AND calls.thread_id=? AND calls.item_type='tool_call'
      AND EXISTS (SELECT 1 FROM model_history_items AS boundary
        WHERE boundary.tenant_id=calls.tenant_id AND boundary.thread_id=calls.thread_id
          AND boundary.item_type NOT IN ('tool_call', 'tool_result') AND boundary.sequence>calls.sequence
          AND boundary.sequence<COALESCE(results.sequence, 9223372036854775807)) LIMIT 1`,
    )
    .get(locator.tenantId, locator.threadId);
  if (interrupted !== undefined)
    throw new RunStoreError("model_history_tool_result_missing");
}

export function validateSqliteModelHistoryAppend(
  database: DatabaseSync,
  locator: ThreadLocator,
  append: ModelHistoryAppend,
): void {
  const state = ensureSqliteModelHistoryAppendState(database, locator);
  const itemId = database.prepare(
    "SELECT 1 FROM model_history_items WHERE item_id=?",
  );
  validateModelHistoryAppendShape(
    append,
    locator,
    state.lastSequence,
    (id) => itemId.get(id) !== undefined,
  );
  const referencedToolCalls = new Map<string, StoredHistoryToolCall>();
  const queried = new Set<string>();
  const load =
    database.prepare(`SELECT calls.segment_id, json_extract(calls.item_json, '$.kind') AS tool_kind,
      EXISTS (SELECT 1 FROM model_history_items AS results
        WHERE results.tenant_id=calls.tenant_id AND results.thread_id=calls.thread_id
          AND results.run_id=calls.run_id AND results.item_type='tool_result'
          AND json_extract(results.item_json, '$.callId')=json_extract(calls.item_json, '$.callId')) AS completed
    FROM model_history_items AS calls
    WHERE calls.tenant_id=? AND calls.thread_id=? AND calls.run_id=?
      AND calls.item_type='tool_call' AND json_extract(calls.item_json, '$.callId')=?`);
  for (const item of append.items) {
    if (item.type !== "tool_call" && item.type !== "tool_result") continue;
    const key = historyToolCallKey(item.runId, item.callId);
    if (queried.has(key)) continue;
    queried.add(key);
    const row = load.get(
      locator.tenantId,
      locator.threadId,
      item.runId,
      item.callId,
    );
    if (row === undefined) continue;
    if (
      typeof row.segment_id !== "string" ||
      (row.tool_kind !== "function" && row.tool_kind !== "custom") ||
      item.runId === null
    )
      throw new RunStoreError("model_history_append_state_invalid");
    referencedToolCalls.set(key, {
      runId: item.runId,
      callId: item.callId,
      segmentId: row.segment_id,
      kind: row.tool_kind,
      completed: row.completed === 1,
    });
  }
  validateModelHistoryIncrementalPairing(append.items, {
    ...state,
    referencedToolCalls,
  });
}
