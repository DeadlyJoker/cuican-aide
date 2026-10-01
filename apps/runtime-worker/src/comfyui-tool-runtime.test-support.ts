import { createHash } from "node:crypto";
import { canonicalActionIntent } from "@crewon/contracts";
import type {
  ToolExecutionCommand,
  ToolRuntimePort,
} from "@crewon/tool-broker";
import { COMFY_SUBMIT_TOOL } from "./extensions/comfyui-tool-runtime.ts";

export function comfyCommand(
  runtime: Pick<ToolRuntimePort, "executionPolicy">,
  options: {
    name?: string;
    args?: unknown;
    runId?: string;
    callId?: string;
    expiresAt?: string;
  } = {},
): ToolExecutionCommand {
  const name = options.name ?? COMFY_SUBMIT_TOOL;
  const policy = runtime.executionPolicy("function", name)!;
  const input = JSON.stringify(
    options.args ?? { prompt: "A ceramic teapot beside a sunlit window." },
  );
  const callId = options.callId ?? "call-1";
  const runId = options.runId ?? "run-1";
  const actionIntent = {
    schemaVersion: "crewon.action-intent.v0" as const,
    runId,
    segmentId: "segment-1",
    callId,
    tool: { kind: "function" as const, name, inputDigest: sha256(input) },
    ...policy,
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
  };
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    kind: "function",
    name,
    input,
    idempotencyKey: `key-${callId}`,
    runId,
    segmentId: "segment-1",
    callId,
    executionId: `execution-${callId}`,
    actionIntent,
    actionDigest: sha256(canonicalActionIntent(actionIntent)),
    approvalProof: null,
    executionLease: {
      workItemId: "work-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      expiresAt: options.expiresAt ?? "2099-09-30T00:00:00.000Z",
    },
  };
}
function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
