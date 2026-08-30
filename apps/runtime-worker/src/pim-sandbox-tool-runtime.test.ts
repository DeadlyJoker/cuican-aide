import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalActionIntent } from "@crewon/contracts";
import type {
  ToolExecutionCommand,
  ToolRuntimePort,
} from "@crewon/tool-broker";

import type { ThreadSandboxPort } from "../../control-api/src/pim-sandbox-client.ts";
import {
  createConfiguredPimSandboxToolRuntime,
  createPimSandboxToolRuntime,
} from "./pim-sandbox-tool-runtime.ts";

test("projects the PIM workspace through durable model-facing tools", async () => {
  const calls: unknown[] = [];
  const sandbox = fixtureSandbox(calls);
  const runtime = createPimSandboxToolRuntime(sandbox);

  assert.deepEqual(
    runtime.definitions().map(({ name }) => name),
    [
      "workspace_list_directory",
      "workspace_read_file",
      "workspace_git_diff",
      "workspace_run_command",
    ],
  );
  assert.equal(
    runtime.executionPolicy("function", "workspace_read_file")?.effect,
    "readOnly",
  );
  assert.deepEqual(
    runtime.executionPolicy("function", "workspace_run_command"),
    {
      effect: "mutation",
      recovery: "reconcilable",
      resourceBindingId: "pim-workspace-sandbox",
      credentialBindingId: "pim-sandbox-service",
      executionTarget: { kind: "control", bindingId: "pim-sandbox" },
      capability: "workspace.command.v0",
      approvalRequirement: "none",
      limits: {
        timeoutMs: 125_000,
        maxOutputBytes: 64 * 1024,
        maxArtifactBytes: 1,
      },
    },
  );

  const outputs = await Promise.all([
    execute(
      runtime,
      "workspace_list_directory",
      { path: "/workspace/src" },
      1,
    ),
    execute(runtime, "workspace_read_file", { path: "README.md" }, 2),
    execute(runtime, "workspace_git_diff", {}, 3),
    execute(
      runtime,
      "workspace_run_command",
      {
        command: "npm test -- task-planner",
        cwd: "/workspace",
        timeoutSeconds: 90,
      },
      4,
    ),
  ]);

  assert.deepEqual(outputs, [
    {
      root: "/workspace",
      path: "/workspace/src",
      entries: [],
      truncated: false,
    },
    {
      path: "/workspace/README.md",
      content: "# fixture\n",
      byteLength: 10,
      truncated: false,
    },
    { cwd: "/workspace", diff: "diff --git a/x b/x\n" },
    {
      cwd: "/workspace",
      exitCode: 0,
      stderr: "",
      stdout: "2 tests passed\n",
    },
  ]);
  assert.deepEqual(calls, [
    ["list", "/workspace/src"],
    ["read", "/workspace/README.md"],
    ["diff"],
    [
      "command",
      {
        command: "npm test -- task-planner",
        cwd: "/workspace",
        timeoutSeconds: 90,
      },
    ],
  ]);
});

test("fails closed for partial configuration and malformed model input", async () => {
  assert.equal(createConfiguredPimSandboxToolRuntime({}), undefined);
  assert.throws(
    () =>
      createConfiguredPimSandboxToolRuntime({
        CREWON_PIM_SANDBOX_BASE_URL: "https://pim.example.com",
      }),
    /CREWON_PIM_SANDBOX_configuration_incomplete/u,
  );
  assert.deepEqual(
    createConfiguredPimSandboxToolRuntime({
      CREWON_PIM_SANDBOX_BASE_URL: "https://pim.example.com",
      CREWON_PIM_SANDBOX_USERNAME: "admin",
      CREWON_PIM_SANDBOX_PASSWORD: "secret",
      CREWON_PIM_SANDBOX_AGENT_ID: "42",
    })
      ?.definitions()
      .map(({ name }) => name),
    [
      "workspace_list_directory",
      "workspace_read_file",
      "workspace_git_diff",
      "workspace_run_command",
    ],
  );

  const runtime = createPimSandboxToolRuntime(fixtureSandbox([]));
  await assert.rejects(
    runtime.execute(
      command(runtime, "workspace_read_file", '{"path":42}', 1),
      signal(),
    ),
    /workspace_path_invalid/u,
  );
  await assert.rejects(
    runtime.execute(
      command(
        runtime,
        "workspace_run_command",
        '{"command":"pwd","extra":true}',
        2,
      ),
      signal(),
    ),
    /workspace_tool_input_invalid/u,
  );
});

function fixtureSandbox(calls: unknown[]): ThreadSandboxPort {
  return {
    async listDirectory(path) {
      calls.push(["list", path]);
      return {
        root: "/workspace",
        path: path ?? "/workspace",
        entries: [],
        truncated: false,
      };
    },
    async readFile(path) {
      calls.push(["read", path]);
      return {
        path,
        content: "# fixture\n",
        byteLength: 10,
        truncated: false,
      };
    },
    async readDiff() {
      calls.push(["diff"]);
      return { cwd: "/workspace", diff: "diff --git a/x b/x\n" };
    },
    async runCommand(input) {
      calls.push(["command", input]);
      return {
        cwd: input.cwd ?? "/workspace",
        exitCode: 0,
        stderr: "",
        stdout: "2 tests passed\n",
      };
    },
  };
}

async function execute(
  runtime: ToolRuntimePort,
  name: string,
  input: Record<string, unknown>,
  sequence: number,
): Promise<unknown> {
  const resolution = await runtime.execute(
    command(runtime, name, JSON.stringify(input), sequence),
    signal(),
  );
  assert.equal(resolution.status, "completed");
  if (resolution.status !== "completed") return null;
  assert.equal(resolution.result.isError, false);
  return JSON.parse(resolution.result.output);
}

function command(
  runtime: ToolRuntimePort,
  name: string,
  input: string,
  sequence: number,
): ToolExecutionCommand {
  const policy = runtime.executionPolicy("function", name);
  assert.ok(policy);
  const callId = `call-${sequence}`;
  const actionIntent = {
    schemaVersion: "crewon.action-intent.v0" as const,
    runId: "run-1",
    segmentId: "segment-1",
    callId,
    tool: {
      kind: "function" as const,
      name,
      inputDigest: sha256(input),
    },
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
    ...policy,
  };
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    executionId: `execution-${sequence}`,
    executionLease: {
      workItemId: "work-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    actionDigest: sha256(canonicalActionIntent(actionIntent)),
    actionIntent,
    approvalProof: null,
    idempotencyKey: `run-1/tool/${callId}`,
    runId: "run-1",
    segmentId: "segment-1",
    callId,
    kind: "function",
    name,
    input,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
