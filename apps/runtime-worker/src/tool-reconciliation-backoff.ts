import type { DomainStore } from "@crewon/application";
import type { RunState } from "@crewon/domain";

const MAXIMUM_RECONCILIATION_DELAY_MS = 5 * 60 * 1000;

/** Uses durable tool attempts, so process restarts cannot reset the delay. */
export function toolReconciliationDelay(
  baseMs: number,
  attemptNumber: number,
): number {
  if (baseMs === 0) return 0;
  // Respect an explicitly slower worker retry interval; never overflow at high counts.
  const ceiling = Math.max(baseMs, MAXIMUM_RECONCILIATION_DELAY_MS);
  return Math.min(
    ceiling,
    baseMs * 2 ** Math.min(52, Math.max(0, attemptNumber - 1)),
  );
}

export async function loadToolReconciliationDelay(
  store: DomainStore,
  run: RunState,
  baseMs: number,
): Promise<number> {
  if (run.reconciliationReceiptId === null) return baseMs;
  const receipt = await store.loadToolExecutionReceipt({
    tenantId: run.tenantId,
    runId: run.runId,
    receiptId: run.reconciliationReceiptId,
  });
  if (receipt === null) return baseMs;
  const step = await store.loadRunStep({
    tenantId: run.tenantId,
    runId: run.runId,
    stepId: receipt.stepId,
  });
  return toolReconciliationDelay(baseMs, step?.attemptCount ?? 1);
}
