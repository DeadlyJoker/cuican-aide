import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalActionIntent } from "@crewon/contracts";
import type {
  ToolExecutionCommand,
  ToolExecutionPolicyContext,
  ToolExecutionResolution,
  ToolRuntimePort,
} from "@crewon/tool-broker";

import {
  createConfiguredLocalWorkspaceCommandToolRuntime,
  createLocalWorkspaceCommandToolRuntime,
} from "./local-workspace-command-tool-runtime.ts";

test("exposes the desktop workspace command as an approved mutation", () => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-local-command-"));
  try {
    const runtime = createLocalWorkspaceCommandToolRuntime(directory);

    assert.deepEqual(
      runtime.definitions().map(({ name }) => name),
      ["workspace_run_command"],
    );
    assert.deepEqual(
      runtime.executionPolicy("function", "workspace_run_command"),
      {
        effect: "mutation",
        recovery: "reconcilable",
        resourceBindingId: "local-workspace",
        credentialBindingId: null,
        executionTarget: { kind: "control", bindingId: "local-workspace" },
        capability: "workspace.command.v0",
        approvalRequirement: "perAction",
        limits: {
          timeoutMs: 125_000,
          maxOutputBytes: 64 * 1024,
          maxArtifactBytes: 1,
        },
      },
    );
    assert.deepEqual(
      runtime.executionPolicy("function", "workspace_run_command", {
        sandboxMode: "danger-full-access",
      }),
      {
        effect: "mutation",
        recovery: "reconcilable",
        resourceBindingId: "local-host",
        credentialBindingId: null,
        executionTarget: { kind: "control", bindingId: "local-host" },
        capability: "host.command.v0",
        approvalRequirement: "perAction",
        limits: {
          timeoutMs: 125_000,
          maxOutputBytes: 64 * 1024,
          maxArtifactBytes: 1,
        },
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "workspace-write blocks host writes while full access permits the same command",
  { skip: process.platform !== "darwin" },
  async () => {
    const parent = mkdtempSync(join(tmpdir(), "crewon-local-sandbox-"));
    const directory = join(parent, "workspace");
    const temporaryDirectory = join(directory, ".tmp");
    const outsideDirectory = join(parent, "outside");
    const outside = join(parent, "outside.txt");
    mkdirSync(directory);
    mkdirSync(temporaryDirectory);
    mkdirSync(outsideDirectory);
    symlinkSync(outsideDirectory, join(directory, "escape"), "dir");
    try {
      const runtime = createLocalWorkspaceCommandToolRuntime(directory, {
        ...process.env,
        TEMP: temporaryDirectory,
        TMP: temporaryDirectory,
        TMPDIR: temporaryDirectory,
      });
      const escaped = join(outsideDirectory, "escaped.txt");
      const command = `printf inside > inside.txt; printf outside > '${outside}'; printf escaped > escape/escaped.txt`;
      const restricted = await runtime.execute(
        approvedCommand(
          runtime,
          JSON.stringify({ command, timeoutSeconds: 10 }),
          "workspace-write",
        ),
        new AbortController().signal,
      );

      assert.equal(restricted.status, "completed");
      if (restricted.status !== "completed") return;
      assert.notEqual(JSON.parse(restricted.result.output).exitCode, 0);
      assert.equal(
        readFileSync(join(directory, "inside.txt"), "utf8"),
        "inside",
      );
      assert.equal(existsSync(outside), false);
      assert.equal(existsSync(escaped), false);

      const unrestricted = await runtime.execute(
        approvedCommand(
          runtime,
          JSON.stringify({ command, timeoutSeconds: 10 }),
          "danger-full-access",
        ),
        new AbortController().signal,
      );
      assert.equal(unrestricted.status, "completed");
      if (unrestricted.status !== "completed") return;
      assert.equal(JSON.parse(unrestricted.result.output).exitCode, 0);
      assert.equal(readFileSync(outside, "utf8"), "outside");
      assert.equal(readFileSync(escaped, "utf8"), "escaped");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test(
  "workspace-write blocks network access while full access permits it",
  { skip: process.platform !== "darwin" },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "crewon-local-network-"));
    const temporaryDirectory = join(directory, ".tmp");
    mkdirSync(temporaryDirectory);
    const server = createServer((_request, response) => {
      response.end("reachable");
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    try {
      const address = server.address();
      assert.ok(address !== null && typeof address !== "string");
      const runtime = createLocalWorkspaceCommandToolRuntime(directory, {
        ...process.env,
        TEMP: temporaryDirectory,
        TMP: temporaryDirectory,
        TMPDIR: temporaryDirectory,
      });
      const input = JSON.stringify({
        command: `/usr/bin/curl -fsS --max-time 2 http://127.0.0.1:${address.port}/`,
        timeoutSeconds: 10,
      });

      const restricted = await runtime.execute(
        approvedCommand(runtime, input, "workspace-write"),
        new AbortController().signal,
      );
      assert.equal(restricted.status, "completed");
      if (restricted.status !== "completed") return;
      assert.notEqual(JSON.parse(restricted.result.output).exitCode, 0);

      const unrestricted = await runtime.execute(
        approvedCommand(runtime, input, "danger-full-access"),
        new AbortController().signal,
      );
      assert.equal(unrestricted.status, "completed");
      if (unrestricted.status !== "completed") return;
      const output = JSON.parse(unrestricted.result.output);
      assert.equal(output.exitCode, 0);
      assert.equal(output.stdout, "reachable");
    } finally {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("runs an approved command below the virtual workspace root without leaking runtime secrets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-local-command-"));
  const nested = join(directory, "nested");
  mkdirSync(nested);
  try {
    const runtime = createLocalWorkspaceCommandToolRuntime(directory, {
      ...process.env,
      CREWON_MODEL_API_KEY: "must-not-reach-command",
    });
    const shellCommand =
      process.platform === "win32"
        ? "if defined CREWON_MODEL_API_KEY (exit /b 19) else (echo ready>created.txt)"
        : 'if [ -n "$CREWON_MODEL_API_KEY" ]; then exit 19; fi; printf ready > created.txt';
    const resolution = await runtime.execute(
      approvedCommand(
        runtime,
        JSON.stringify({
          command: shellCommand,
          cwd: "/workspace/nested",
          timeoutSeconds: 10,
        }),
      ),
      new AbortController().signal,
    );

    assert.equal(resolution.status, "completed");
    if (resolution.status !== "completed") return;
    assert.deepEqual(JSON.parse(resolution.result.output), {
      cwd: "/workspace/nested",
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    assert.equal(
      readFileSync(join(nested, "created.txt"), "utf8").trim(),
      "ready",
    );
    assert.deepEqual(resolution.result.workspaceChanges, {
      schemaVersion: "crewon.workspace-change-summary.v0",
      paths: [],
      additions: 0,
      deletions: 0,
      statsComplete: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("treats dot as the selected workspace root", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-local-command-"));
  try {
    const runtime = createLocalWorkspaceCommandToolRuntime(directory);
    const resolution = await runtime.execute(
      approvedCommand(
        runtime,
        JSON.stringify({
          command: process.platform === "win32" ? "cd" : "pwd",
          cwd: ".",
          timeoutSeconds: 10,
        }),
      ),
      new AbortController().signal,
    );

    assert.equal(resolution.status, "completed");
    if (resolution.status !== "completed") return;
    assert.equal(resolution.result.isError, false);
    assert.equal(JSON.parse(resolution.result.output).cwd, "/workspace");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("returns a tool error for working directories outside the selected workspace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-local-command-"));
  try {
    const runtime = createLocalWorkspaceCommandToolRuntime(directory);
    const resolution = await runtime.execute(
      approvedCommand(
        runtime,
        JSON.stringify({ command: "echo blocked", cwd: "/tmp" }),
      ),
      new AbortController().signal,
    );

    assert.equal(resolution.status, "completed");
    if (resolution.status !== "completed") return;
    assert.equal(resolution.result.isError, true);
    assert.deepEqual(JSON.parse(resolution.result.output), {
      error: "local_workspace_command_cwd_invalid",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only configures the command tool for a bound desktop workspace", () => {
  assert.equal(createConfiguredLocalWorkspaceCommandToolRuntime({}), undefined);
  assert.throws(
    () =>
      createConfiguredLocalWorkspaceCommandToolRuntime({
        CREWON_DESKTOP_WORKSPACE_ROOT: "relative/path",
      }),
    /CREWON_DESKTOP_WORKSPACE_ROOT_invalid/u,
  );
});

test("releases completed results in both sandbox policy runtimes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-local-result-release-"));
  try {
    const runtime = createLocalWorkspaceCommandToolRuntime(directory);
    const commands = ["workspace-write", "danger-full-access"].map(
      (sandboxMode) =>
        approvedCommand(
          runtime,
          JSON.stringify({
            command: "echo released",
            cwd: "/workspace",
            timeoutSeconds: 10,
          }),
          sandboxMode as ToolExecutionPolicyContext["sandboxMode"],
        ),
    );
    const results: ToolExecutionResolution[] = [];
    for (const command of commands)
      results.push(
        await runtime.execute(command, new AbortController().signal),
      );
    assert.equal(
      runtime.retainedExecutionResults?.({ runId: "run-1", limit: 128 }).length,
      2,
    );
    for (const [index, command] of commands.entries()) {
      const result = results[index]!;
      assert.equal(result.status, "completed");
      runtime.acknowledgeExecutionResult?.({
        ...command,
        status: "completed",
        providerReceiptId: result.providerReceiptId,
      });
      assert.equal(
        runtime.retainedExecutionResults?.({ runId: "run-1", limit: 128 })
          .length,
        1 - index,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("measures the real workspace command adapter and its shared-workspace serialization", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-command-latency-"));
  try {
    writeFileSync(join(directory, "sample.txt"), "workspace-result");
    const runtime = createLocalWorkspaceCommandToolRuntime(directory);
    const run = async (label: string, command: string) => {
      const input = approvedCommand(
        runtime,
        JSON.stringify({ command, timeoutSeconds: 10 }),
        "danger-full-access",
        { runId: label, callId: label },
      );
      const started = performance.now();
      const result = await runtime.execute(input, new AbortController().signal);
      assert.equal(result.status, "completed");
      if (result.status !== "completed")
        throw Error("command did not complete");
      const output = JSON.parse(result.result.output);
      assert.equal(output.exitCode, 0, output.stderr);
      runtime.acknowledgeExecutionResult?.({
        ...input,
        status: "completed",
        providerReceiptId: result.providerReceiptId,
      });
      return { elapsedMs: performance.now() - started, stdout: output.stdout };
    };
    const isolated = await run("isolated", "cat sample.txt");
    assert.equal(isolated.stdout, "workspace-result");
    const slow = run("slow-run", "sleep 0.3; printf slow");
    const queued = run("other-run", "cat sample.txt");
    const [a, b] = await Promise.all([slow, queued]);
    assert.equal(b.stdout, "workspace-result");
    assert.ok(
      b.elapsedMs >= 250,
      "commands sharing a workspace must retain the mutation fence",
    );
    t.diagnostic(
      JSON.stringify({
        scenario: "actual-workspace-command",
        isolatedMs: isolated.elapsedMs,
        slowMs: a.elapsedMs,
        queuedQuickMs: b.elapsedMs,
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function approvedCommand(
  runtime: ToolRuntimePort,
  input: string,
  sandboxMode: ToolExecutionPolicyContext["sandboxMode"] = "workspace-write",
  identity?: { runId: string; callId: string },
): ToolExecutionCommand {
  const runId = identity?.runId ?? "run-1";
  const callId = identity?.callId ?? "call-1";
  const policy = runtime.executionPolicy("function", "workspace_run_command", {
    sandboxMode,
  });
  assert.ok(policy);
  const actionIntent = {
    schemaVersion: "crewon.action-intent.v0" as const,
    runId,
    segmentId: "segment-1",
    callId,
    tool: {
      kind: "function" as const,
      name: "workspace_run_command",
      inputDigest: sha256(input),
    },
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
    ...policy,
  };
  const actionDigest = sha256(canonicalActionIntent(actionIntent));
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    executionId: identity === undefined ? "execution-1" : `${runId}:${callId}`,
    executionLease: {
      workItemId: "work-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      leaseId: "lease-1",
      leaseEpoch: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    actionDigest,
    actionIntent,
    approvalProof: {
      schemaVersion: "crewon.tool-approval-proof.v0",
      approvalId: "approval-1",
      actionDigest,
      policySnapshotId: "policy-1",
      approvalRevision: 2,
      decidedAt: "2026-09-03T00:00:00.000Z",
    },
    idempotencyKey: `${runId}/tool/${callId}`,
    runId,
    segmentId: "segment-1",
    callId,
    kind: "function",
    name: "workspace_run_command",
    input,
  };
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
