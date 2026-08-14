import type {
  RunExecutionService,
  ToolExecutionCall,
  WorkItemClaim,
} from "@crewon/application";
import type { KernelAgentEvent } from "@crewon/agent-kernel/runtime";
import type { ToolApprovalState } from "@crewon/domain";
import type { ToolRuntimePort } from "@crewon/tool-broker";

type ToolRequest = Extract<KernelAgentEvent, { type: "tool.requested" }>;

/**
 * Selects the latest canonical pending ActionIntent. The prepared receipt is
 * the audit/idempotency identity; model event text alone can never authorize
 * replacement. Selecting one stable event prevents retries from oscillating
 * between older prepared receipts in the same Tool boundary.
 */
export async function replaceChangedToolApproval(
  input: Readonly<{
    execution: RunExecutionService;
    claim: WorkItemClaim;
    current: ToolApprovalState;
    calls: readonly ToolRequest[];
    toolRuntime: ToolRuntimePort;
    expiresAfterMs: number | null;
    retryAfterMs: number;
  }>,
): Promise<ToolApprovalState | null> {
  const event = input.calls.at(-1);
  if (event === undefined) {
    return null;
  }
  const policy = input.toolRuntime.executionPolicy(
    event.data.kind,
    event.data.name,
  );
  if (policy?.approvalRequirement !== "perAction") {
    return null;
  }
  const call: ToolExecutionCall = {
    segmentId: event.segmentId,
    callId: event.data.callId,
    kind: event.data.kind,
    name: event.data.name,
    input: event.data.input,
  };
  const receipt = await input.execution.loadToolApprovalReplacementReceipt(
    input.claim,
    input.current,
    call,
    policy,
  );
  return receipt === null
    ? null
    : input.execution.replaceToolApproval(input.claim, input.current, receipt, {
        expiresAfterMs: input.expiresAfterMs,
        retryAfterMs: input.retryAfterMs,
      });
}
