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
  const execution = command("first");
  const reservation = await composite.reserveExecution(
    execution,
    new AbortController().signal,
  );
  assert.ok(reservation !== undefined);
  await reservation.execute();
  reservation.release();
  assert.equal(composite.readRetainedExecutionResult(execution), null);
  composite.acknowledgeExecutionResult({
    ...execution,
    status: "completed",
    providerReceiptId: "receipt-first",
  });
  assert.deepEqual(calls, [
    "second:execute",
    "first:reconcile",
    "second:cancel",
    "first:reserve",
    "first:reserved-execute",
    "first:release",
    "first:read",
    "first:acknowledge",
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

test("forwards the Run sandbox context to the routed policy owner", () => {
  let sandboxMode: string | undefined;
  const child = runtime("command", []);
  const contextual: ToolRuntimePort = {
    ...child,
    executionPolicy: (kind, name, context) => {
      sandboxMode = context?.sandboxMode;
      return child.executionPolicy(kind, name, context);
    },
  };
  const composite = new CompositeToolRuntime([contextual]);

  assert.deepEqual(
    composite.executionPolicy("function", "command", {
      sandboxMode: "danger-full-access",
    }),
    policy(),
  );
  assert.equal(sandboxMode, "danger-full-access");
});

test("close waits for every owner, reports failure and reuses one promise even when an owner throws synchronously", async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const first = {
    ...runtime("first", calls),
    close: () => {
      calls.push("first:close");
      throw new Error("close_failed");
    },
  };
  const second = {
    ...runtime("second", calls),
    close: () => {
      calls.push("second:close");
      return held;
    },
  };
  const composite = new CompositeToolRuntime([first, second]);
  const closing = composite.close();
  let settled = false;
  const rejected = assert.rejects(closing, /close_failed/).then(() => {
    settled = true;
  });
  for (let i = 0; i < 1000; i++) assert.equal(composite.close(), closing);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(calls, ["first:close", "second:close"]);
  finish();
  await rejected;
  assert.equal(composite.close(), closing);
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
    reserveExecution(command) {
      calls.push(`${name}:reserve`);
      return {
        execute: async () => {
          calls.push(`${name}:reserved-execute`);
          return completed(command);
        },
        release: () => {
          calls.push(`${name}:release`);
        },
      };
    },
    async reconcile(command) {
      calls.push(`${name}:reconcile`);
      return completed(command);
    },
    async cancel(command) {
      calls.push(`${name}:cancel`);
      return completed(command);
    },
    acknowledgeExecutionResult() {
      calls.push(`${name}:acknowledge`);
    },
    readRetainedExecutionResult() {
      calls.push(`${name}:read`);
      return null;
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
