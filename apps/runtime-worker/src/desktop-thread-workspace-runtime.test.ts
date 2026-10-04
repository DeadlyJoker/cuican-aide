import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { existsSync } from "node:fs";
import test from "node:test";
import { canonicalActionIntent } from "@crewon/contracts";
import {
  type ToolRuntimePort,
  type ToolExecutionCommand,
} from "@crewon/tool-broker";
import {
  DesktopThreadWorkspaceToolRuntime,
  type DesktopWorkspaceThreadStore,
  resolveDesktopThreadWorkspace,
} from "./desktop-thread-workspace-runtime.ts";
import { createLocalWorkspaceCommandToolRuntime } from "./local-workspace-command-tool-runtime.ts";
import { createConfiguredToolRuntime } from "./runtime-process-environment.ts";
import { withToolExecutionCapacity } from "./tool-execution-capacity.ts";

const readTool = "mcp__workspace_checks__read_file";

test("concurrent MCP reads and commands follow each Thread after selection and resume", async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const createRuntime = async (root: string) =>
    (await createConfiguredToolRuntime({
      CREWON_DESKTOP_WORKSPACE_ROOT: root,
      CREWON_MCP_STDIO_CONFIG_PATH: writeMcpConfig(f.directory, root),
    }))!;
  let runtime = new DesktopThreadWorkspaceToolRuntime(
    await createRuntime(f.catalog),
    { ...f.config, createRuntime },
  );
  context.after(() => runtime.close());
  const signal = new AbortController().signal;
  let admittedUnbound = false;
  await assert.rejects(
    withToolExecutionCapacity(
      {
        runtime,
        tenantId: "tenant",
        command: command(
          runtime,
          "run-legacy",
          readTool,
          JSON.stringify({ path: "sentinel.txt" }),
        ),
        signal,
        operation: "execute",
      },
      (execute) => {
        admittedUnbound = true;
        return execute();
      },
    ),
    /thread_unbound/,
  );
  assert.equal(admittedUnbound, false);
  const inputs = ["A", "B"].map((id) =>
    command(
      runtime,
      `run-${id}`,
      readTool,
      JSON.stringify({ path: "sentinel.txt" }),
    ),
  );
  const responses = await Promise.all(
    inputs.map((input) =>
      withToolExecutionCapacity(
        {
          runtime,
          tenantId: "tenant",
          command: input,
          signal,
          operation: "execute",
        },
        (execute) => execute(),
      ),
    ),
  );
  assert.match(JSON.stringify(responses[0]), /only-A/);
  assert.match(JSON.stringify(responses[1]), /only-B/);
  f.select("A");
  assert.deepEqual(await runtime.reconcile(inputs[1]!, signal), responses[1]);
  const retained = runtime.retainedExecutionResults({
    runId: "run-B",
    limit: 10,
  });
  assert.equal(retained.length, 1);
  const result = responses[1]!;
  assert.equal(result.status, "completed");
  if (result.status === "completed")
    runtime.acknowledgeExecutionResult({
      ...inputs[1]!,
      status: "completed",
      providerReceiptId: result.providerReceiptId,
    });
  assert.equal(
    runtime.retainedExecutionResults({ runId: "run-B", limit: 10 }).length,
    0,
  );
  const commands = await Promise.all(
    ["A", "B"].map((id) =>
      runtime.execute(
        command(
          runtime,
          `run-${id}`,
          "workspace_run_command",
          JSON.stringify({ command: "cat sentinel.txt", timeoutSeconds: 10 }),
        ),
        signal,
      ),
    ),
  );
  assert.match(JSON.stringify(commands[0]), /only-A/);
  assert.match(JSON.stringify(commands[1]), /only-B/);
  await runtime.close();
  f.select("B");
  runtime = new DesktopThreadWorkspaceToolRuntime(
    await createRuntime(f.catalog),
    { ...f.config, createRuntime },
  );
  const resumed = await runtime.reconcile(inputs[0]!, signal);
  assert.match(JSON.stringify(resumed), /only-A/);
  assert.doesNotMatch(JSON.stringify(resumed), /only-B/);
});

test("unbound, deleted, cross-space and missing workspace threads cannot acquire the active root", async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.directory, { recursive: true, force: true }));
  for (const runId of [
    "run-legacy",
    "run-missing",
    "run-deleted",
    "run-other",
    "run-absent",
  ]) {
    await assert.rejects(
      resolveDesktopThreadWorkspace({ ...f.config, runId }),
      /desktop_workspace_(thread|run|binding)_/,
    );
  }
  f.select("B");
  assert.equal(
    (await resolveDesktopThreadWorkspace({ ...f.config, runId: "run-A" })).root,
    f.roots.A,
  );
  rmSync(f.roots.A, { recursive: true });
  await assert.rejects(
    resolveDesktopThreadWorkspace({ ...f.config, runId: "run-A" }),
    /binding_unavailable/,
  );
});

test("closing during ownership lookup never starts a late workspace child", async (context) => {
  const f = fixture();
  context.after(() => rmSync(f.directory, { recursive: true, force: true }));
  let resume!: () => void;
  const waiting = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const readRun = f.config.store.loadRun;
  f.config.store.loadRun = async (locator) => {
    await waiting;
    return readRun(locator);
  };
  let started = 0;
  const catalog = createLocalWorkspaceCommandToolRuntime(f.catalog);
  const runtime = new DesktopThreadWorkspaceToolRuntime(catalog, {
    ...f.config,
    createRuntime: async (root) => {
      started++;
      return createLocalWorkspaceCommandToolRuntime(root);
    },
  });
  const pending = runtime.prepareExecution(
    command(
      runtime,
      "run-A",
      "workspace_run_command",
      JSON.stringify({ command: "cat sentinel.txt" }),
    ),
    new AbortController().signal,
  );
  await runtime.close();
  resume();
  await assert.rejects(pending, /tool_runtime_closed/);
  assert.equal(started, 0);
});

test("production cannot enable local desktop registry tools", async () => {
  await assert.rejects(
    createConfiguredToolRuntime({
      CREWON_DESKTOP_WORKSPACE_REGISTRY_PATH: "/tmp/registry",
      CREWON_CONTROL_SECURITY_MODE: "production",
    }),
    /registry_forbidden/,
  );
});

function fixture() {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-thread-spaces-")),
  );
  const roots = { A: join(directory, "A"), B: join(directory, "B") };
  const catalog = join(directory, "catalog");
  mkdirSync(catalog);
  for (const [id, root] of Object.entries(roots)) {
    mkdirSync(root);
    writeFileSync(join(root, "sentinel.txt"), `only-${id}`);
  }
  const registryPath = join(directory, "desktop-workspace.json");
  const select = (id: string) =>
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: "crewon.desktop-workspace-authority.v2",
        revision: 1,
        activeWorkspaceId: `workspace-${id}`,
        workspaces: Object.entries(roots).map(([id, root]) => ({
          workspaceId: `workspace-${id}`,
          root,
        })),
      }),
    );
  select("B");
  const store: DesktopWorkspaceThreadStore = {
    async loadRun({ tenantId, runId }) {
      return runId === "run-absent"
        ? null
        : {
            tenantId,
            runId,
            spaceId: runId === "run-other" ? "other-space" : "space",
            threadId: runId.replace("run-", "thread-"),
          };
    },
    async loadThreadInSpace(locator) {
      return {
        ...locator,
        status: locator.threadId === "thread-deleted" ? "deleted" : "active",
        workspaceId:
          locator.threadId === "thread-legacy"
            ? null
            : locator.threadId.replace("thread-", "workspace-"),
      };
    },
  };
  return {
    directory,
    roots,
    catalog,
    select,
    config: {
      registryPath,
      databasePath: join(directory, "unused.sqlite"),
      tenantId: "tenant",
      spaceId: "space",
      store,
    },
  };
}

function writeMcpConfig(directory: string, root: string) {
  const path = join(directory, `mcp-${root.split("/").at(-1)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: "crewon.mcp-stdio-config.v0",
      servers: [
        {
          serverId: "workspace_checks",
          command: process.execPath,
          args: [resolve("../../scripts/local-workspace-checks-mcp.mjs")],
          cwd: root,
          env: {
            PATH: "/usr/bin:/bin",
            CREWON_LOCAL_WORKSPACE_ROOT: root,
            CREWON_LOCAL_PNPM_PATH: (process.env.PATH ?? "")
              .split(delimiter)
              .map((entry) => join(entry, "pnpm"))
              .find((entry) => existsSync(entry))!,
            CREWON_LOCAL_GIT_PATH: "/usr/bin/git",
          },
          tools: {
            read_file: {
              effect: "readOnly",
              recovery: "replaySafe",
              resourceBindingId: "local-workspace",
              credentialBindingId: null,
              executionTarget: {
                kind: "control",
                bindingId: "local-workspace",
              },
              capability: "workspace.read_only_command.v0",
              approvalRequirement: "none",
              limits: {
                timeoutMs: 125000,
                maxOutputBytes: 65536,
                maxArtifactBytes: 1,
              },
            },
          },
        },
      ],
    }),
  );
  return path;
}

function command(
  runtime: ToolRuntimePort,
  runId: string,
  name: string,
  input: string,
): ToolExecutionCommand {
  const policy = runtime.executionPolicy("function", name, {
    sandboxMode: "workspace-write",
  });
  assert.ok(policy);
  const callId = name;
  const actionIntent = {
    schemaVersion: "crewon.action-intent.v0" as const,
    runId,
    segmentId: "segment",
    callId,
    tool: { kind: "function" as const, name, inputDigest: hash(input) },
    policySnapshotId: "policy",
    workspaceBindingId: null,
    ...policy,
  };
  const actionDigest = hash(canonicalActionIntent(actionIntent));
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    runId,
    segmentId: "segment",
    callId,
    kind: "function",
    name,
    input,
    idempotencyKey: `${runId}/${callId}`,
    executionId: `execution-${runId}-${callId}`,
    executionLease: {
      workItemId: "work",
      stepId: "step",
      attemptId: "attempt",
      leaseId: "lease",
      leaseEpoch: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    actionDigest,
    actionIntent,
    approvalProof:
      policy.approvalRequirement === "none"
        ? null
        : {
            schemaVersion: "crewon.tool-approval-proof.v0",
            approvalId: "approval",
            actionDigest,
            policySnapshotId: "policy",
            approvalRevision: 2,
            decidedAt: "2026-09-14T00:00:00.000Z",
          },
  };
}
function hash(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
