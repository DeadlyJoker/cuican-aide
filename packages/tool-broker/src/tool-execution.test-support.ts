import { createHash } from "node:crypto";
import { canonicalActionIntent } from "@crewon/contracts";
import type {
  ToolExecutionCommand,
  ToolExecutionPolicy,
  ToolInvocation,
  ToolExecutionResultAcknowledgement,
} from "./tool-broker-port.ts";

export function committedResult(
  execution: ToolExecutionCommand,
  providerReceiptId: string | null,
): ToolExecutionResultAcknowledgement {
  return {
    executionId: execution.executionId,
    idempotencyKey: execution.idempotencyKey,
    actionDigest: execution.actionDigest,
    actionIntent: execution.actionIntent,
    status: "completed",
    providerReceiptId,
  };
}

function invocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    idempotencyKey: "run-1/segment-1/call-1",
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    kind: "function",
    name: "tool",
    input: "{}",
    ...overrides,
  };
}

export function command(
  overrides: Partial<ToolExecutionCommand> = {},
  executionPolicy = policy("readOnly", "replaySafe"),
): ToolExecutionCommand {
  const baseInvocation = invocation(overrides);
  const actionIntent = {
    schemaVersion: "crewon.action-intent.v0" as const,
    runId: baseInvocation.runId,
    segmentId: baseInvocation.segmentId,
    callId: baseInvocation.callId,
    tool: {
      kind: baseInvocation.kind,
      name: baseInvocation.name,
      inputDigest: sha256(baseInvocation.input),
    },
    effect: executionPolicy.effect,
    recovery: executionPolicy.recovery,
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
    resourceBindingId: executionPolicy.resourceBindingId,
    credentialBindingId: executionPolicy.credentialBindingId,
    executionTarget: executionPolicy.executionTarget,
    capability: executionPolicy.capability,
    approvalRequirement: executionPolicy.approvalRequirement,
    limits: executionPolicy.limits,
  };
  return {
    ...baseInvocation,
    executionId: "execution-1",
    executionLease: executionLease(),
    actionDigest: sha256(canonicalActionIntent(actionIntent)),
    actionIntent,
    approvalProof: null,
    ...overrides,
  };
}

function executionLease(): ToolExecutionCommand["executionLease"] {
  return {
    workItemId: "work-item-1",
    stepId: "step-1",
    attemptId: "attempt-1",
    leaseId: "lease-1",
    leaseEpoch: 1,
    expiresAt: "2099-08-09T00:00:00.000Z",
  };
}

export function policy(
  effect: "readOnly" | "mutation",
  recovery: "replaySafe" | "reconcilable",
  approvalRequirement: "none" | "perAction" = "none",
): ToolExecutionPolicy {
  return {
    effect,
    recovery,
    resourceBindingId: null,
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId: "in-memory-tool-broker" },
    capability: effect === "mutation" ? "workspace.write" : "workspace.read",
    approvalRequirement,
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 256 * 1024,
      maxArtifactBytes: 1024 * 1024,
    },
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function definition(name: string) {
  return {
    schemaVersion: "crewon.tool-definition.v0" as const,
    kind: "function" as const,
    name,
    description: `${name} test Tool.`,
    execution: "serial" as const,
    inputSchema: { type: "object" },
  };
}
