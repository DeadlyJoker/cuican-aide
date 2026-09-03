import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalActionIntent } from "@crewon/contracts";
import type {
  ToolExecutionCommand,
  ToolRuntimePort,
} from "@crewon/tool-broker";

import {
  PimSandboxMutationOutcomeUnknownError,
  type ThreadSandboxPort,
} from "../../control-api/src/pim-sandbox-client.ts";
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
  assert.equal(
    runtime.executionPolicy("function", "workspace_read_file")?.limits
      .maxArtifactBytes,
    64 * 1024,
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
        timeoutMs: 140_000,
        maxOutputBytes: 64 * 1024,
        maxArtifactBytes: 64 * 1024,
      },
    },
  );

  const outputs = await Promise.all([
    execute(runtime, "workspace_list_directory", { path: "/workspace/src" }, 1),
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
    {
      cwd: "/workspace",
      diff: "diff --git a/x b/x\n",
      isGitRepository: true,
      branch: "main",
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      changedFiles: 1,
      additions: 1,
      deletions: 0,
      statsComplete: true,
      diffTruncated: false,
    },
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
      "tracked-command",
      {
        command: "npm test -- task-planner",
        cwd: "/workspace",
        timeoutSeconds: 90,
      },
    ],
  ]);
});

test("keeps tracked workspace changes separate from model-visible command output", async () => {
  const runtime = createPimSandboxToolRuntime(fixtureSandbox([]));
  const resolution = await runtime.execute(
    command(
      runtime,
      "workspace_run_command",
      JSON.stringify({ command: "printf changed > src/task.ts" }),
      1,
    ),
    signal(),
  );

  assert.equal(resolution.status, "completed");
  if (resolution.status !== "completed") return;
  assert.deepEqual(JSON.parse(resolution.result.output), {
    cwd: "/workspace",
    exitCode: 0,
    stderr: "",
    stdout: "2 tests passed\n",
  });
  assert.deepEqual(resolution.result.workspaceChanges, {
    schemaVersion: "crewon.workspace-change-summary.v0",
    paths: ["src/task.ts"],
    additions: 2,
    deletions: 1,
    statsComplete: true,
  });
  assert.equal(
    resolution.result.output.includes("workspaceChanges"),
    false,
    "workspace accounting must not depend on a model-visible preview",
  );
});

test("retains workspace evidence when command streams need JSON-aware truncation", async () => {
  const sandbox = fixtureSandbox([]);
  sandbox.runTrackedCommand = async () => ({
    command: {
      cwd: "/workspace",
      exitCode: 0,
      stdout: "\u0000".repeat(24 * 1024),
      stderr: "\u0001".repeat(24 * 1024),
    },
    workspaceChanges: {
      schemaVersion: "crewon.workspace-change-summary.v0",
      paths: ["src/task.ts"],
      additions: 1,
      deletions: 0,
      statsComplete: true,
    },
  });
  const runtime = createPimSandboxToolRuntime(sandbox);
  const resolution = await runtime.execute(
    command(runtime, "workspace_run_command", '{"command":"generate"}', 1),
    signal(),
  );

  assert.equal(resolution.status, "completed");
  if (resolution.status !== "completed") return;
  assert.equal(Buffer.byteLength(resolution.result.output) <= 64 * 1024, true);
  assert.match(resolution.result.output, /characters truncated/u);
  assert.deepEqual(resolution.result.workspaceChanges, {
    schemaVersion: "crewon.workspace-change-summary.v0",
    paths: ["src/task.ts"],
    additions: 1,
    deletions: 0,
    statsComplete: true,
  });
});

test("maps a post-dispatch PIM failure to a reconcilable unknown outcome", async () => {
  const sandbox = fixtureSandbox([]);
  sandbox.runTrackedCommand = async () => {
    throw new PimSandboxMutationOutcomeUnknownError({
      cause: new Error("connection closed after write"),
    });
  };
  const runtime = createPimSandboxToolRuntime(sandbox);

  const resolution = await runtime.execute(
    command(runtime, "workspace_run_command", '{"command":"write"}', 1),
    signal(),
  );

  assert.deepEqual(resolution, {
    status: "unknownOutcome",
    executionId: "execution-1",
    providerReceiptId: null,
  });
});

test("aborting a dispatched workspace mutation resolves promptly as unknown", async () => {
  const sandbox = fixtureSandbox([]);
  sandbox.runTrackedCommand = async (_request, abortSignal) =>
    new Promise((_resolve, reject) => {
      abortSignal?.addEventListener(
        "abort",
        () => reject(abortSignal.reason ?? new Error("aborted")),
        { once: true },
      );
    });
  const runtime = createPimSandboxToolRuntime(sandbox);
  const controller = new AbortController();
  const running = runtime.execute(
    command(runtime, "workspace_run_command", '{"command":"sleep 60"}', 1),
    controller.signal,
  );
  controller.abort(new Error("stop requested"));

  assert.deepEqual(await running, {
    status: "unknownOutcome",
    executionId: "execution-1",
    providerReceiptId: null,
  });
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
      return {
        cwd: "/workspace",
        diff: "diff --git a/x b/x\n",
        isGitRepository: true,
        branch: "main",
        head: "a".repeat(40),
        changedFiles: 1,
        additions: 1,
        deletions: 0,
        statsComplete: true,
        diffTruncated: false,
      };
    },
    async readGitSummary() {
      calls.push(["git-summary"]);
      return {
        cwd: "/workspace",
        isGitRepository: true,
        branch: "main",
        head: "a".repeat(40),
        changedFiles: 1,
        additions: 1,
        deletions: 0,
        statsComplete: true,
      };
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
    async runTrackedCommand(input) {
      calls.push(["tracked-command", input]);
      return {
        command: {
          cwd: input.cwd ?? "/workspace",
          exitCode: 0,
          stderr: "",
          stdout: "2 tests passed\n",
        },
        workspaceChanges: {
          schemaVersion: "crewon.workspace-change-summary.v0",
          paths: ["src/task.ts"],
          additions: 2,
          deletions: 1,
          statsComplete: true,
        },
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
