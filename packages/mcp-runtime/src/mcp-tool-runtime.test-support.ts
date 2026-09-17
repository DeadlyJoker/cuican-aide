import { createHash } from "node:crypto";
import { canonicalActionIntent } from "@crewon/contracts";
import type {
  ToolExecutionCommand,
  ToolExecutionPolicy,
} from "@crewon/tool-broker";

export function executionCommand(
  policy = readOnlyPolicy(),
  originalName = "echo",
): ToolExecutionCommand {
  const input = '{"value":"hello"}';
  const name = `mcp__fixture__${originalName}`;
  const actionIntent = {
    schemaVersion: "crewon.action-intent.v0" as const,
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    tool: {
      kind: "function" as const,
      name,
      inputDigest: sha256(input),
    },
    effect: policy.effect,
    recovery: policy.recovery,
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
    resourceBindingId: policy.resourceBindingId,
    credentialBindingId: policy.credentialBindingId,
    executionTarget: policy.executionTarget,
    capability: policy.capability,
    approvalRequirement: policy.approvalRequirement,
    limits: policy.limits,
  };
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    executionId: "execution-1",
    executionLease: {
      workItemId: "work-item-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      expiresAt: "2099-08-09T00:00:00.000Z",
    },
    actionDigest: sha256(canonicalActionIntent(actionIntent)),
    actionIntent,
    approvalProof: null,
    idempotencyKey: "run-1/tool/call-1",
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    kind: "function",
    name,
    input,
  };
}

export function mutationPolicy(): ToolExecutionPolicy {
  return {
    ...readOnlyPolicy(),
    effect: "mutation",
    recovery: "reconcilable",
    capability: "mcp.tool.mutate",
    approvalRequirement: "none",
  };
}

export function readOnlyPolicy(): ToolExecutionPolicy {
  return {
    effect: "readOnly",
    recovery: "replaySafe",
    resourceBindingId: "mcp-server-fixture",
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId: "mcp-runtime-fixture" },
    capability: "mcp.tool.read",
    approvalRequirement: "none",
    limits: {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 1024 * 1024,
    },
  };
}

function sha256(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}
