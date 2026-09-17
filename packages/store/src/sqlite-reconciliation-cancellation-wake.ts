import type { DatabaseSync } from "node:sqlite";
import type { RunLifecycleEvent, RunState } from "@crewon/domain";
import { readLeaseClock, type LeaseClock } from "./lease-clock.ts";
import {
  canceledReconciliationReceipt,
  RECONCILIATION_CANCEL_WAKE,
} from "./reconciliation-cancellation-wake.ts";

export function wakeSqliteCanceledReconciliation(
  database: DatabaseSync,
  state: RunState,
  events: readonly RunLifecycleEvent[],
  clock: LeaseClock,
): void {
  const receiptId = canceledReconciliationReceipt(state, events);
  if (receiptId === null) return;
  const now = readLeaseClock(clock);
  database
    .prepare(
      `UPDATE work_items
    SET available_at_ms = MIN(available_at_ms, ?), last_error_code = ?
    WHERE work_item_id = (
      SELECT work_item_id FROM tool_execution_receipts
      WHERE receipt_id = ? AND tenant_id = ? AND run_id = ?
    ) AND tenant_id = ? AND run_id = ? AND status IN ('pending', 'leased')`,
    )
    .run(
      now,
      RECONCILIATION_CANCEL_WAKE,
      receiptId,
      state.tenantId,
      state.runId,
      state.tenantId,
      state.runId,
    );
}
