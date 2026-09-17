import type { ToolExecutionReceiptState } from "@crewon/domain";
import type { DomainStore } from "@crewon/application";
import {
  ToolBrokerError,
  type ToolRuntimePort,
  type RetainedToolExecutionResult,
} from "@crewon/tool-broker";

/** Call only with a Store-committed resolution, including an unknown-outcome fence. */
export function acknowledgeCommittedToolResult(
  runtime: ToolRuntimePort,
  receipt: ToolExecutionReceiptState,
): boolean {
  if (
    receipt.status !== "completed" &&
    receipt.status !== "canceled" &&
    receipt.status !== "unknownOutcome"
  ) {
    throw new ToolBrokerError("tool_result_receipt_not_terminal");
  }
  // Legacy persisted receipts may not carry a digest-bound action. They cannot
  // match a newly validated in-memory execution, so leave acknowledgement out.
  if (receipt.actionIntent === null) return false;
  if (
    receipt.status === "unknownOutcome" &&
    runtime.readRetainedExecutionResult !== undefined
  ) {
    const local = runtime.readRetainedExecutionResult({
      executionId: receipt.executionId,
      idempotencyKey: receipt.idempotencyKey,
      actionDigest: receipt.actionDigest,
      actionIntent: receipt.actionIntent,
    });
    // A provider's uncertainty cannot discard a stronger local completion.
    // Null also covers older routed adapters without a local lookup API.
    if (local !== null && local.status !== "unknownOutcome") return false;
  }
  if (runtime.acknowledgeExecutionResult === undefined) return false;
  return (
    runtime.acknowledgeExecutionResult({
      executionId: receipt.executionId,
      idempotencyKey: receipt.idempotencyKey,
      actionDigest: receipt.actionDigest,
      actionIntent: receipt.actionIntent,
      status: receipt.status,
      providerReceiptId: receipt.providerReceiptId,
    }) !== false
  );
}

/** Repair only retained metadata for this Run, without scanning its event history. */
export async function reconcileCommittedToolResults(
  input: Readonly<{
    runtime: ToolRuntimePort;
    store: Pick<DomainStore, "loadToolExecutionReceiptByAction">;
    tenantId: string;
    runId: string;
  }>,
): Promise<void> {
  const results =
    input.runtime.retainedExecutionResults?.({
      runId: input.runId,
      limit: 128,
    }) ?? [];
  for (const result of results) {
    await reconcileCommittedToolResult({ ...input, result });
  }
}

/** Read-only receipt verification; no lease is needed to release a matching local copy. */
export async function reconcileCommittedToolResult(input: {
  runtime: ToolRuntimePort;
  store: Pick<DomainStore, "loadToolExecutionReceiptByAction">;
  tenantId: string;
  runId: string;
  result: RetainedToolExecutionResult;
  mayAcknowledge?: () => boolean;
}): Promise<boolean> {
  const { result } = input;
  const receipt = await input.store.loadToolExecutionReceiptByAction({
    tenantId: input.tenantId,
    runId: input.runId,
    actionDigest: result.actionDigest,
  });
  if (input.mayAcknowledge?.() === false || receipt === null) return false;
  if (
    receipt.tenantId !== input.tenantId ||
    receipt.runId !== input.runId ||
    receipt.executionId !== result.executionId ||
    receipt.idempotencyKey !== result.idempotencyKey ||
    receipt.actionDigest !== result.actionDigest ||
    receipt.call.kind !== result.kind ||
    receipt.call.name !== result.name
  )
    throw new ToolBrokerError("tool_result_receipt_identity_mismatch");
  if (
    receipt.actionIntent === null ||
    (receipt.status !== "completed" &&
      receipt.status !== "canceled" &&
      receipt.status !== "unknownOutcome")
  )
    return false;
  if (receipt.status === "unknownOutcome" && result.status !== "unknownOutcome")
    return false;
  return acknowledgeCommittedToolResult(input.runtime, receipt);
}
