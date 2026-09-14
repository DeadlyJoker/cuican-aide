import type { PoolClient } from "pg";
import type { RunLifecycleEvent, RunState } from "@crewon/domain";
import {
  canceledReconciliationReceipt,
  RECONCILIATION_CANCEL_WAKE,
} from "./reconciliation-cancellation-wake.ts";

export async function wakePostgresCanceledReconciliation(
  client: PoolClient,
  schemaSql: string,
  state: RunState,
  events: readonly RunLifecycleEvent[],
): Promise<void> {
  const receiptId = canceledReconciliationReceipt(state, events);
  if (receiptId === null) return;
  await client.query(
    `UPDATE ${schemaSql}.work_items
    SET available_at = LEAST(available_at, clock_timestamp()), last_error_code = $1
    WHERE work_item_id = (
      SELECT work_item_id FROM ${schemaSql}.tool_execution_receipts
      WHERE receipt_id = $2 AND tenant_id = $3 AND run_id = $4
    ) AND tenant_id = $3 AND run_id = $4 AND status IN ('pending', 'leased')`,
    [RECONCILIATION_CANCEL_WAKE, receiptId, state.tenantId, state.runId],
  );
}
