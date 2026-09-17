import type {
  DomainStore,
  RunExecutionService,
  WorkItemClaim,
} from "@crewon/application";
import type { ToolExecutionReceiptState } from "@crewon/domain";
import { ToolBrokerError, type ToolRuntimePort } from "@crewon/tool-broker";
import { acknowledgeCommittedToolResult } from "./committed-tool-result.ts";

type CancellationResultDrain =
  | { kind: "settled" }
  | { kind: "more" }
  | {
      kind: "unknown";
      receipt: ToolExecutionReceiptState;
      providerReceiptId: string | null;
    };

/** One bounded pass. Receipt writes keep the current lease and never append model history. */
export async function settleCanceledToolResults(input: {
  runtime: ToolRuntimePort;
  store: Pick<DomainStore, "loadToolExecutionReceiptByAction">;
  execution: Pick<
    RunExecutionService,
    "completeToolExecutionAfterCancellation" | "cancelToolExecutionReceipt"
  >;
  claim: WorkItemClaim;
}): Promise<CancellationResultDrain> {
  const { runtime, claim } = input;
  if (runtime.readRetainedExecutionResult === undefined)
    return { kind: "settled" };
  const results =
    runtime.retainedExecutionResults?.({
      runId: claim.workItem.runId,
      limit: 128,
      visibility: "includePending",
    }) ?? [];
  if (results.length > 128)
    throw new ToolBrokerError("tool_result_query_limit_invalid");
  let settled = 0;
  let unknown: Extract<CancellationResultDrain, { kind: "unknown" }> | null =
    null;
  for (const metadata of results) {
    let receipt = await input.store.loadToolExecutionReceiptByAction({
      tenantId: claim.workItem.tenantId,
      runId: claim.workItem.runId,
      actionDigest: metadata.actionDigest,
    });
    if (receipt === null || receipt.actionIntent === null) continue;
    if (
      receipt.executionId !== metadata.executionId ||
      receipt.idempotencyKey !== metadata.idempotencyKey ||
      receipt.actionDigest !== metadata.actionDigest ||
      receipt.call.kind !== metadata.kind ||
      receipt.call.name !== metadata.name
    )
      throw new ToolBrokerError("tool_result_receipt_identity_mismatch");
    const lookup = { ...metadata, actionIntent: receipt.actionIntent };
    const resolution =
      (receipt.workItemId === claim.workItem.workItemId
        ? runtime.cancelRetainedExecution?.(lookup)
        : null) ?? runtime.readRetainedExecutionResult(lookup);
    if (resolution === null) continue;
    if (resolution.executionId !== receipt.executionId)
      throw new ToolBrokerError("tool_result_receipt_identity_mismatch");
    if (receipt.status === "completed" || receipt.status === "canceled") {
      acknowledgeCommittedToolResult(runtime, receipt);
      settled += 1;
      continue;
    }
    // This claim cannot settle another Work Item's effects.
    if (receipt.workItemId !== claim.workItem.workItemId) continue;
    if (resolution.status === "unknownOutcome") {
      unknown ??= {
        kind: "unknown",
        receipt,
        providerReceiptId: resolution.providerReceiptId,
      };
      continue;
    }
    if (resolution.status === "completed") {
      if (resolution.result.callId !== receipt.call.callId)
        throw new ToolBrokerError("tool_result_receipt_identity_mismatch");
      receipt = await input.execution.completeToolExecutionAfterCancellation(
        claim,
        receipt,
        resolution.providerReceiptId,
        resolution.result,
      );
    } else {
      receipt = await input.execution.cancelToolExecutionReceipt(
        claim,
        receipt,
        resolution.providerReceiptId,
      );
    }
    // If either the write or ACK fails, the next claim repairs using the durable receipt.
    acknowledgeCommittedToolResult(runtime, receipt);
    settled += 1;
  }
  return (
    unknown ??
    (results.length === 128 && settled > 0
      ? { kind: "more" }
      : { kind: "settled" })
  );
}
