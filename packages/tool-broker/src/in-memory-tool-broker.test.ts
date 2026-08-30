import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalActionIntent } from "@crewon/contracts";

import { InMemoryToolBroker } from "./in-memory-tool-broker.ts";
import {
  ToolBrokerError,
  type ToolExecutionCommand,
  type ToolExecutionPolicy,
  type ToolInvocation,
} from "./tool-broker-port.ts";

test("returns the Rust-compatible model-visible output for an unknown custom tool", async () => {
  const broker = new InMemoryToolBroker();
  const call = command({
    kind: "custom",
    name: "unsupported_tool",
    input: '"payload"',
  });

  const first = await broker.execute(call, signal());
  const replay = await broker.execute(call, signal());

  assert.deepEqual(first, {
    status: "completed",
    executionId: "execution-1",
    providerReceiptId: "in-memory:execution-1",
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: "call-1",
      output: "unsupported custom tool call: unsupported_tool",
      isError: true,
      artifactRef: null,
    },
  });
  assert.deepEqual(replay, first);
});

test("executes a registered tool once for an idempotent invocation", async () => {
  let executions = 0;
  const broker = new InMemoryToolBroker(
    [
      {
        schemaVersion: "crewon.tool-definition.v0",
        kind: "function",
        name: "fixture_reader",
        description: "Returns a deterministic fixture.",
        execution: "serial",
        inputSchema: { type: "object", additionalProperties: false },
      },
    ],
    new Map([
      [
        "function:fixture_reader",
        async () => {
          executions += 1;
          return { output: "fixture", artifactRef: "artifact-1" };
        },
      ],
    ]),
    new Map([["function:fixture_reader", policy("readOnly", "replaySafe")]]),
  );
  const call = command({ name: "fixture_reader", input: "{}" });

  const [first, replay] = await Promise.all([
    broker.execute(call, signal()),
    broker.execute(call, signal()),
  ]);

  assert.equal(executions, 1);
  assert.deepEqual(first, replay);
  assert.deepEqual(broker.definitions(), [
    {
      schemaVersion: "crewon.tool-definition.v0",
      kind: "function",
      name: "fixture_reader",
      description: "Returns a deterministic fixture.",
      execution: "serial",
      inputSchema: { type: "object", additionalProperties: false },
    },
  ]);
});

test("fails closed on idempotency reuse with a different invocation", async () => {
  const broker = new InMemoryToolBroker();
  const first = command({ name: "one" });
  await broker.execute(first, signal());

  assert.throws(
    () =>
      broker.execute(
        command({
          name: "two",
          idempotencyKey: first.idempotencyKey,
          executionId: first.executionId,
        }),
        signal(),
      ),
    (error) =>
      error instanceof ToolBrokerError &&
      error.code === "tool_idempotency_conflict",
  );
});

test("rejects a malformed durable execution lease before Provider dispatch", async () => {
  let invocations = 0;
  const broker = new InMemoryToolBroker(
    [definition("tool")],
    new Map([
      [
        "function:tool",
        async () => {
          invocations += 1;
          return { output: "unexpected" };
        },
      ],
    ]),
    new Map([["function:tool", policy("readOnly", "replaySafe")]]),
  );
  assert.throws(
    () =>
      broker.execute(
        command({
          executionLease: { ...executionLease(), leaseEpoch: 0 },
        }),
        signal(),
      ),
    hasCode("tool_lease_epoch_invalid"),
  );
  assert.equal(invocations, 0);
});

test("converts handler failures to a bounded model-visible result without leaking the cause", async () => {
  const broker = new InMemoryToolBroker(
    [
      {
        schemaVersion: "crewon.tool-definition.v0",
        kind: "function",
        name: "failing_tool",
        description: "Fails deterministically.",
        execution: "serial",
        inputSchema: { type: "object" },
      },
    ],
    new Map([
      [
        "function:failing_tool",
        async () => {
          throw new Error("secret backend failure");
        },
      ],
    ]),
    new Map([["function:failing_tool", policy("readOnly", "replaySafe")]]),
  );

  const resolution = await broker.execute(
    command({ name: "failing_tool" }),
    signal(),
  );

  assert.deepEqual(resolution, {
    status: "completed",
    executionId: "execution-1",
    providerReceiptId: "in-memory:execution-1",
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: "call-1",
      output: "tool call failed: failing_tool",
      isError: true,
      artifactRef: null,
    },
  });
  assert.equal(
    resolution.status === "completed" &&
      resolution.result.output.includes("secret"),
    false,
  );
});

test("executes once and reconciles the same provider receipt", async () => {
  let executions = 0;
  const broker = new InMemoryToolBroker(
    [definition("fixture_writer")],
    new Map([
      [
        "function:fixture_writer",
        async () => {
          executions += 1;
          return { output: "written" };
        },
      ],
    ]),
    new Map([["function:fixture_writer", policy("mutation", "reconcilable")]]),
  );
  const execution = command(
    { name: "fixture_writer" },
    policy("mutation", "reconcilable"),
  );

  const completed = await broker.execute(execution, signal());
  const reconciled = await broker.reconcile(execution, signal());

  assert.equal(executions, 1);
  assert.deepEqual(reconciled, completed);
  assert.deepEqual(broker.executionPolicy("function", "fixture_writer"), {
    ...policy("mutation", "reconcilable"),
  });
});

test("does not replay a mutation when a restarted provider cannot prove its outcome", async () => {
  let executions = 0;
  const definitions = [definition("fixture_writer")];
  const handlers = new Map([
    [
      "function:fixture_writer",
      async () => {
        executions += 1;
        return { output: "written" };
      },
    ],
  ]);
  const policies = new Map([
    ["function:fixture_writer", policy("mutation", "reconcilable")],
  ]);
  const execution = command(
    { name: "fixture_writer" },
    policy("mutation", "reconcilable"),
  );
  await new InMemoryToolBroker(definitions, handlers, policies).execute(
    execution,
    signal(),
  );

  const reconciled = await new InMemoryToolBroker(
    definitions,
    handlers,
    policies,
  ).reconcile(execution, signal());

  assert.equal(executions, 1);
  assert.deepEqual(reconciled, {
    status: "unknownOutcome",
    executionId: execution.executionId,
    providerReceiptId: null,
  });
});

test("requires an explicit recovery policy before a registered handler executes", async () => {
  const broker = new InMemoryToolBroker(
    [definition("unclassified_tool")],
    new Map([["function:unclassified_tool", async () => ({ output: "no" })]]),
  );

  assert.throws(
    () => broker.execute(command({ name: "unclassified_tool" }), signal()),
    hasCode("tool_execution_policy_missing"),
  );
  assert.throws(
    () =>
      new InMemoryToolBroker(
        [definition("unsafe_writer")],
        new Map(),
        new Map([["function:unsafe_writer", policy("mutation", "replaySafe")]]),
      ),
    hasCode("tool_mutation_not_reconcilable"),
  );
});

test("requires a digest-bound approval proof for every per-action Provider call", async () => {
  const executionPolicy = policy("mutation", "reconcilable", "perAction");
  const broker = new InMemoryToolBroker(
    [definition("approved_writer")],
    new Map([
      ["function:approved_writer", async () => ({ output: "written" })],
    ]),
    new Map([["function:approved_writer", executionPolicy]]),
  );
  const withoutProof = command({ name: "approved_writer" }, executionPolicy);
  assert.throws(
    () => broker.execute(withoutProof, signal()),
    hasCode("tool_approval_proof_invalid"),
  );
  const approved = {
    ...withoutProof,
    approvalProof: {
      schemaVersion: "crewon.tool-approval-proof.v0" as const,
      approvalId: "approval-1",
      actionDigest: withoutProof.actionDigest,
      policySnapshotId: withoutProof.actionIntent.policySnapshotId,
      approvalRevision: 2,
      decidedAt: "2026-08-08T00:01:00Z",
    },
  };
  assert.equal((await broker.execute(approved, signal())).status, "completed");
});

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

function command(
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

function policy(
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

function definition(name: string) {
  return {
    schemaVersion: "crewon.tool-definition.v0" as const,
    kind: "function" as const,
    name,
    description: `${name} test Tool.`,
    execution: "serial" as const,
    inputSchema: { type: "object" },
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ToolBrokerError && error.code === code;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
