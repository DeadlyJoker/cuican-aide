import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalActionIntent } from "@crewon/contracts";

import { CompositeToolRuntime } from "./composite-tool-runtime.ts";
import type {
  ToolDefinition,
  ToolExecutionCommand,
  ToolExecutionPolicy,
  ToolRuntimePort,
} from "./tool-broker-port.ts";
import { ToolBrokerError } from "./tool-broker-port.ts";

test("routes disjoint definitions to their exact runtime", async () => {
  const calls: string[] = [];
  const first = runtime("first", calls);
  const second = runtime("second", calls);
  const composite = new CompositeToolRuntime([second, first]);

  assert.deepEqual(
    composite.definitions().map((definition) => definition.name),
    ["first", "second"],
  );
  assert.deepEqual(composite.executionPolicy("function", "second"), policy());
  await composite.execute(command("second"), new AbortController().signal);
  await composite.reconcile(command("first"), new AbortController().signal);
  await composite.cancel(command("second"), new AbortController().signal);
  assert.deepEqual(calls, [
    "second:execute",
    "first:reconcile",
    "second:cancel",
  ]);
});

test("rejects definition collisions and unknown routes", async () => {
  assert.throws(
    () => new CompositeToolRuntime([runtime("same", []), runtime("same", [])]),
    hasCode("tool_runtime_definition_conflict"),
  );
  const composite = new CompositeToolRuntime([runtime("known", [])]);
  assert.throws(
    () => composite.execute(command("missing"), new AbortController().signal),
    hasCode("tool_runtime_route_not_found"),
  );
});

function runtime(name: string, calls: string[]): ToolRuntimePort {
  const definition = toolDefinition(name);
  return {
    definitions: () => [definition],
    executionPolicy: (kind, toolName) =>
      kind === "function" && toolName === name ? policy() : null,
    async execute(command) {
      calls.push(`${name}:execute`);
      return completed(command);
    },
    async reconcile(command) {
      calls.push(`${name}:reconcile`);
      return completed(command);
    },
    async cancel(command) {
      calls.push(`${name}:cancel`);
      return completed(command);
    },
  };
}

function toolDefinition(name: string): ToolDefinition {
  return {
    schemaVersion: "crewon.tool-definition.v0",
    kind: "function",
    name,
    description: `Runs ${name}.`,
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
    executionTarget: { kind: "control", bindingId: "control-1" },
    capability: "fixture.read",
    approvalRequirement: "none",
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 1024 * 1024,
    },
  };
}

function command(name: string): ToolExecutionCommand {
  const actionIntent = {
    schemaVersion: "crewon.action-intent.v0" as const,
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    tool: {
      kind: "function" as const,
      name,
      inputDigest: sha256("{}"),
    },
    effect: "readOnly" as const,
    recovery: "replaySafe" as const,
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
    resourceBindingId: null,
    credentialBindingId: null,
    executionTarget: { kind: "control" as const, bindingId: "control-1" },
    capability: "fixture.read",
    approvalRequirement: "none" as const,
    limits: policy().limits,
  };
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    executionId: `execution-${name}`,
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
    idempotencyKey: `execution-${name}`,
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    kind: "function",
    name,
    input: "{}",
  };
}

function completed(command: ToolExecutionCommand) {
  return {
    status: "completed" as const,
    executionId: command.executionId,
    providerReceiptId: `receipt-${command.name}`,
    result: {
      schemaVersion: "crewon.tool-result.v0" as const,
      callId: command.callId,
      output: "done",
      isError: false,
      artifactRef: null,
    },
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ToolBrokerError && error.code === code;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
