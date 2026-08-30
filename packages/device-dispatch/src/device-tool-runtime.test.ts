import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalActionIntent } from "@crewon/contracts";
import type {
  ToolDefinition,
  ToolExecutionCommand,
  ToolExecutionPolicy,
  ToolExecutionResolution,
} from "@crewon/tool-broker";

import {
  DeviceToolRuntime,
  type DeviceCommandSignInput,
  type DeviceDispatchClientPort,
  type DeviceDispatchResolution,
} from "./device-tool-runtime.ts";

test("maps the renewed durable Tool lease into an exact signed Device command", async () => {
  const signedInputs: DeviceCommandSignInput[] = [];
  const dispatched: unknown[] = [];
  const runtime = new DeviceToolRuntime({
    definitions: [definition()],
    policies: new Map([["function:workspace_read", policy()]]),
    bindings: {
      async resolve(bindingId) {
        assert.equal(bindingId, "device-binding-1");
        return { deviceId: "device-1" };
      },
    },
    signer: {
      async sign(input) {
        signedInputs.push(input);
        return signedCommand(input);
      },
    },
    dispatch: dispatchClient({
      execute: async (command) => {
        dispatched.push(command);
        return deviceCompleted();
      },
    }),
  });

  assert.deepEqual(
    await runtime.execute(command(), new AbortController().signal),
    completed(),
  );
  assert.equal(signedInputs.length, 1);
  assert.deepEqual(signedInputs[0]?.command, {
    schemaVersion: "crewon.device-command.v0",
    protocolVersion: 1,
    deviceId: "device-1",
    leaseId: "lease-9",
    leaseEpoch: 9,
    expiresAt: "2099-08-09T00:00:00.000Z",
    runId: "run-1",
    stepId: "step-1",
    attemptId: "attempt-1",
    executionId: "execution-1",
    workspaceBindingId: "workspace-1",
    capability: "workspace.read",
    actionDigest: command().actionDigest,
    arguments: { path: "relative/file.txt" },
    payloadRef: null,
    limits: policy().limits,
    idempotencyKey: `device:${command().actionDigest.slice("sha256:".length)}`,
    traceContext: { traceparent: null, tracestate: null },
  });
  assert.equal(dispatched.length, 1);
  await runtime.close();
});

test("keeps execute, reconcile and cancel as explicit remote operations", async () => {
  const operations: string[] = [];
  const runtime = new DeviceToolRuntime({
    definitions: [definition()],
    policies: new Map([["function:workspace_read", policy()]]),
    bindings: { resolve: async () => ({ deviceId: "device-1" }) },
    signer: { sign: async (input) => signedCommand(input) },
    dispatch: dispatchClient({
      execute: async () => {
        operations.push("execute");
        return deviceCompleted();
      },
      reconcile: async () => {
        operations.push("reconcile");
        return {
          status: "unknownOutcome",
          executionId: "execution-1",
          providerReceiptId: "receipt-1",
        };
      },
      cancel: async () => {
        operations.push("cancel");
        return {
          status: "canceled",
          executionId: "execution-1",
          providerReceiptId: "receipt-1",
        };
      },
    }),
  });
  const signal = new AbortController().signal;

  assert.equal((await runtime.execute(command(), signal)).status, "completed");
  assert.equal(
    (await runtime.reconcile(command(), signal)).status,
    "unknownOutcome",
  );
  assert.equal((await runtime.cancel(command(), signal)).status, "canceled");
  assert.deepEqual(operations, ["execute", "reconcile", "cancel"]);
});

test("rejects missing deployment bindings and signer mutation before dispatch", async () => {
  let dispatches = 0;
  const unavailable = new DeviceToolRuntime({
    definitions: [definition()],
    policies: new Map([["function:workspace_read", policy()]]),
    bindings: { resolve: async () => null },
    signer: { sign: async (input) => signedCommand(input) },
    dispatch: dispatchClient({
      execute: async () => {
        dispatches += 1;
        return deviceCompleted();
      },
    }),
  });
  await assert.rejects(
    unavailable.execute(command(), new AbortController().signal),
    hasCode("device_binding_unavailable"),
  );

  const mutated = new DeviceToolRuntime({
    definitions: [definition()],
    policies: new Map([["function:workspace_read", policy()]]),
    bindings: { resolve: async () => ({ deviceId: "device-1" }) },
    signer: {
      async sign(input) {
        return {
          ...signedCommand(input),
          capability: "workspace.write",
        };
      },
    },
    dispatch: dispatchClient({
      execute: async () => {
        dispatches += 1;
        return deviceCompleted();
      },
    }),
  });
  await assert.rejects(
    mutated.execute(command(), new AbortController().signal),
    hasCode("device_signed_command_mismatch"),
  );
  assert.equal(dispatches, 0);
});

function definition(): ToolDefinition {
  return {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name: "workspace_read",
    description: "Reads one bounded workspace file.",
    execution: "serial",
    inputSchema: { type: "object" },
  };
}

function policy(): ToolExecutionPolicy {
  return {
    effect: "readOnly",
    recovery: "replaySafe",
    resourceBindingId: null,
    credentialBindingId: null,
    executionTarget: { kind: "device", bindingId: "device-binding-1" },
    capability: "workspace.read",
    approvalRequirement: "none",
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 16 * 1024 * 1024,
    },
  };
}

function command(): ToolExecutionCommand {
  const input = '{"path":"relative/file.txt"}';
  const configured = policy();
  const actionIntent = {
    schemaVersion: "crewon.action-intent.v0" as const,
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    tool: {
      kind: "function" as const,
      name: "workspace_read",
      inputDigest: sha256(input),
    },
    effect: configured.effect,
    recovery: configured.recovery,
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
    resourceBindingId: configured.resourceBindingId,
    credentialBindingId: configured.credentialBindingId,
    executionTarget: configured.executionTarget,
    capability: configured.capability,
    approvalRequirement: configured.approvalRequirement,
    limits: configured.limits,
  };
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    executionId: "execution-1",
    executionLease: {
      workItemId: "work-item-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      leaseId: "lease-9",
      leaseEpoch: 9,
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
    name: "workspace_read",
    input,
  };
}

function signedCommand(input: DeviceCommandSignInput) {
  return {
    ...input.command,
    authorization: {
      schemaVersion: "crewon.device-authorization.v0" as const,
      scheme: "ed25519" as const,
      keyId: "control-key-1",
      issuedAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2099-08-09T00:00:00.000Z",
      approvalProof: input.approvalProof,
      signature: "A".repeat(86),
    },
  };
}

function completed(): ToolExecutionResolution {
  return {
    status: "completed",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: "call-1",
      output: "device output",
      isError: false,
      artifactRef: null,
    },
  };
}

function deviceCompleted(): DeviceDispatchResolution {
  return {
    status: "completed",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    output: "device output",
    artifactRef: null,
  };
}

function dispatchClient(
  overrides: Partial<DeviceDispatchClientPort>,
): DeviceDispatchClientPort {
  const unknown = async (): Promise<DeviceDispatchResolution> => ({
    status: "unknownOutcome",
    executionId: "execution-1",
    providerReceiptId: null,
  });
  return {
    execute: unknown,
    reconcile: unknown,
    cancel: unknown,
    ...overrides,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && "code" in error && error.code === code;
}
