import type { RunLifecycleEvent, RunState } from "@crewon/domain";

// A one-shot queue wake reason, consumed by claim or retry. In particular, a
// request received while leased must survive until that lease releases work.
export const RECONCILIATION_CANCEL_WAKE = "run_cancel_requested";

export function canceledReconciliationReceipt(
  state: RunState,
  events: readonly RunLifecycleEvent[],
): string | null {
  return state.status === "reconciling" &&
    events.some((event) => event.type === "run.cancel.requested")
    ? state.reconciliationReceiptId
    : null;
}
