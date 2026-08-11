import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalActionIntent, type ActionIntent } from "@crewon/contracts";
import {
  CompositeToolRuntime,
  ToolBrokerError,
  type ToolExecutionCommand,
  type ToolRuntimePort,
} from "@crewon/tool-broker";

import {
  WorkspaceReadToolRuntime,
  type DurableWorkspaceReadPort,
  type DurableWorkspaceReadResolution,
} from "./runtime-workspace-read-tool-runtime.ts";

test("exposes the frozen strict read_file definition and bound policy", () => {
  const runtime = toolRuntime().runtime;
  assert.deepEqual(runtime.definitions(), [
    {
      schemaVersion: "crewon.tool-definition.v0",
      kind: "function",
      name: "read_file",
      description: "Read one bounded file.",
      execution: "parallel",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ]);
  assert.deepEqual(runtime.executionPolicy("function", "read_file"), policy());
  assert.equal(runtime.executionPolicy("custom", "read_file"), null);
  assert.equal(runtime.executionPolicy("function", "other"), null);
});

test("delegates the original command and canonical segments and maps an exact UTF-8 result", async () => {
  const calls: PortCall[] = [];
  const { runtime } = toolRuntime({ calls });
  const command = toolCommand("docs/你好.md");
  const resolution = await runtime.execute(command, signal());

  assert.deepEqual(calls, [
    { operation: "execute", command, segments: ["docs", "你好.md"] },
  ]);
  assert.deepEqual(resolution, {
    status: "completed",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: "call-1",
      output: "hello 世界",
      isError: false,
      artifactRef: null,
    },
  });
});

test("rejects malformed, absolute, ambiguous paths and authority-shaped extra keys", async () => {
  const { runtime, calls } = toolRuntime();
  const inputs = [
    "../secret",
    "./README.md",
    "/etc/passwd",
    "docs//readme",
    "docs/",
    "C:\\secret",
    "a\\b",
    "a\0b",
  ];
  for (const path of inputs) {
    await assert.rejects(
      runtime.execute(toolCommand(path), signal()),
      hasCode("workspace_read_path_invalid"),
    );
  }
  for (const input of [
    JSON.stringify({ path: "README.md", deviceId: "device-2" }),
    JSON.stringify({ path: "README.md", workspaceBindingId: "workspace-2" }),
    JSON.stringify({ path: "README.md", approvalProof: {} }),
    JSON.stringify({}),
    "not-json",
  ]) {
    await assert.rejects(
      runtime.execute(toolCommandWithInput(input), signal()),
      hasCode("workspace_read_input_invalid"),
    );
  }
  assert.deepEqual(calls, []);
});

test("fails closed on configured authority and provider identity drift", async () => {
  const { runtime, setResolution, calls } = toolRuntime();
  for (const actionIntent of [
    { ...intent("README.md"), workspaceBindingId: "workspace-2" },
    { ...intent("README.md"), policySnapshotId: "policy-2" },
    {
      ...intent("README.md"),
      executionTarget: {
        kind: "device" as const,
        bindingId: "device-binding-2",
      },
    },
  ]) {
    await assert.rejects(
      runtime.execute(commandForIntent(actionIntent), signal()),
      hasCode("workspace_read_authority_mismatch"),
    );
  }
  assert.deepEqual(calls, []);

  setResolution({ ...completed(), executionId: "execution-substituted" });
  await assert.rejects(
    runtime.execute(toolCommand("README.md"), signal()),
    hasCode("workspace_read_provider_identity_mismatch"),
  );
});

test("preserves unknown and canceled recovery resolutions without regenerating authority", async () => {
  const { runtime, calls, setResolution } = toolRuntime();
  const command = toolCommand("README.md");
  setResolution({
    status: "unknownOutcome",
    executionId: command.executionId,
    providerReceiptId: "receipt-unknown",
  });
  assert.deepEqual(await runtime.reconcile(command, signal()), {
    status: "unknownOutcome",
    executionId: command.executionId,
    providerReceiptId: "receipt-unknown",
  });
  setResolution({
    status: "canceled",
    executionId: command.executionId,
    providerReceiptId: null,
  });
  assert.deepEqual(await runtime.cancel(command, signal()), {
    status: "canceled",
    executionId: command.executionId,
    providerReceiptId: null,
  });
  assert.deepEqual(calls, [
    { operation: "reconcile", command, segments: ["README.md"] },
    { operation: "cancel", command, segments: ["README.md"] },
  ]);
});

test("honors abort before dispatch and after a pending durable read", async () => {
  const before = new AbortController();
  before.abort(new Error("lease lost"));
  const first = toolRuntime();
  await assert.rejects(
    first.runtime.execute(toolCommand("README.md"), before.signal),
    /lease lost/,
  );
  assert.deepEqual(first.calls, []);

  const controller = new AbortController();
  const pending = toolRuntime({
    port: {
      async execute() {
        controller.abort(new Error("caller gone"));
        return completed();
      },
      async reconcile() {
        return assert.fail("not called");
      },
      async cancel() {
        return assert.fail("not called");
      },
    },
  });
  await assert.rejects(
    pending.runtime.execute(toolCommand("README.md"), controller.signal),
    /caller gone/,
  );
});

test("fails closed on result/reference drift and the UTF-8 output bound", async () => {
  const { runtime, setResolution } = toolRuntime();
  const invalid: unknown[] = [
    { ...completed(), providerReceiptId: "bad receipt" },
    { ...completed(), unexpected: true },
    { ...completed(), result: { ...completed().result, encoding: "base64" } },
    { ...completed(), result: { ...completed().result, byteLength: 1 } },
    {
      ...completed(),
      result: {
        ...completed().result,
        content: "x".repeat(65_537),
        byteLength: 65_537,
      },
    },
    {
      status: "unknownOutcome",
      executionId: "execution-1",
      providerReceiptId: null,
      route: "secret",
    },
  ];
  for (const resolution of invalid) {
    setResolution(resolution as DurableWorkspaceReadResolution);
    await assert.rejects(
      runtime.execute(toolCommand("README.md"), signal()),
      hasCode("workspace_read_resolution_invalid"),
    );
  }
});

test("CompositeToolRuntime rejects a read_file catalog collision at startup", () => {
  const first = toolRuntime().runtime;
  const duplicate: ToolRuntimePort = {
    ...first,
    definitions: () => first.definitions(),
    executionPolicy: first.executionPolicy.bind(first),
    execute: first.execute.bind(first),
    reconcile: first.reconcile.bind(first),
    cancel: first.cancel.bind(first),
  };
  assert.throws(
    () => new CompositeToolRuntime([first, duplicate]),
    hasCode("tool_runtime_definition_conflict"),
  );
});

type PortCall = Readonly<{
  operation: "execute" | "reconcile" | "cancel";
  command: ToolExecutionCommand;
  segments: readonly string[];
}>;

function toolRuntime(
  overrides: {
    calls?: PortCall[];
    port?: DurableWorkspaceReadPort;
  } = {},
) {
  const calls = overrides.calls ?? [];
  let resolution: DurableWorkspaceReadResolution = completed();
  const invoke = async (
    operation: PortCall["operation"],
    command: ToolExecutionCommand,
    segments: readonly string[],
  ) => {
    calls.push({ operation, command, segments });
    return resolution;
  };
  const port = overrides.port ?? {
    execute: (command, segments) => invoke("execute", command, segments),
    reconcile: (command, segments) => invoke("reconcile", command, segments),
    cancel: (command, segments) => invoke("cancel", command, segments),
  };
  return {
    calls,
    runtime: new WorkspaceReadToolRuntime({ binding: binding(), port }),
    setResolution(value: DurableWorkspaceReadResolution) {
      resolution = value;
    },
  };
}

function binding() {
  return {
    deviceBindingId: "device-binding-1",
    workspaceBindingId: "workspace-1",
    policySnapshotId: "policy-1",
  };
}

function policy() {
  return {
    effect: "readOnly" as const,
    recovery: "reconcilable" as const,
    resourceBindingId: "workspace-1",
    credentialBindingId: null,
    executionTarget: { kind: "device" as const, bindingId: "device-binding-1" },
    capability: "workspace.read_file.v0",
    approvalRequirement: "none" as const,
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
      maxArtifactBytes: 16_777_216,
    },
  };
}

function toolCommand(path: string): ToolExecutionCommand {
  return toolCommandWithInput(JSON.stringify({ path }));
}

function toolCommandWithInput(input: string): ToolExecutionCommand {
  return commandForIntent(intentForInput(input), input);
}

function intent(path: string): ActionIntent {
  return intentForInput(JSON.stringify({ path }));
}

function intentForInput(input: string): ActionIntent {
  return {
    schemaVersion: "crewon.action-intent.v0",
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    tool: { kind: "function", name: "read_file", inputDigest: sha256(input) },
    ...policy(),
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
  };
}

function commandForIntent(
  actionIntent: ActionIntent,
  suppliedInput?: string,
): ToolExecutionCommand {
  const input = JSON.stringify({ path: "README.md" });
  const actualInput = suppliedInput ?? input;
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    idempotencyKey: "idempotency-1",
    runId: actionIntent.runId,
    segmentId: actionIntent.segmentId,
    callId: actionIntent.callId,
    kind: actionIntent.tool.kind,
    name: actionIntent.tool.name,
    input: actualInput,
    executionId: "execution-1",
    executionLease: {
      workItemId: "work-item-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      expiresAt: "2026-08-12T10:00:00.000Z",
    },
    actionDigest: sha256(canonicalActionIntent(actionIntent)),
    actionIntent,
    approvalProof: null,
  };
}

function completed(): Extract<
  DurableWorkspaceReadResolution,
  { status: "completed" }
> {
  return {
    status: "completed",
    executionId: "execution-1",
    providerReceiptId: "receipt-1",
    result: {
      schemaVersion: "crewon.workspace-file-read-result.v0",
      encoding: "utf8",
      content: "hello 世界",
      byteLength: 12,
    },
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
function signal(): AbortSignal {
  return new AbortController().signal;
}
function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof ToolBrokerError && error.code === code;
}
