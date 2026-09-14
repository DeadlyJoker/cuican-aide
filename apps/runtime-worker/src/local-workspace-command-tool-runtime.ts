import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  InMemoryToolBroker,
  ToolBrokerError,
  type ToolDefinition,
  type ToolExecutionPolicy,
  type ToolExecutionPolicyContext,
  type ToolExecutionCommand,
  type ToolHandler,
  type ToolInvocation,
  type ToolRuntimePort,
} from "@crewon/tool-broker";

const CONFIGURATION_NAME = "CREWON_DESKTOP_WORKSPACE_ROOT";
const VIRTUAL_ROOT = "/workspace";
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 24 * 1024;
const MAX_TIMEOUT_SECONDS = 120;
const TOOL_TIMEOUT_MS = 125_000;
const WORKSPACE_SANDBOX_MODE = "workspace-write";
const FULL_ACCESS_SANDBOX_MODE = "danger-full-access";
type LocalCommandSandboxMode =
  | typeof WORKSPACE_SANDBOX_MODE
  | typeof FULL_ACCESS_SANDBOX_MODE;

const definition: ToolDefinition = {
  schemaVersion: "crewon.tool-definition.v0",
  kind: "function",
  name: "workspace_run_command",
  description:
    "Run a bounded local-host shell command starting in the selected workspace. The command may access or modify host files and requires per-action approval. Use /workspace as the virtual workspace root.",
  execution: "serial",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: { type: "string" },
      cwd: {
        type: "string",
        description:
          "Virtual working directory below /workspace; defaults to /workspace. Use . for the workspace root or ./path for a relative subdirectory.",
      },
      timeoutSeconds: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TIMEOUT_SECONDS,
      },
    },
    required: ["command"],
  },
};

const workspacePolicy: ToolExecutionPolicy = {
  effect: "mutation",
  recovery: "reconcilable",
  resourceBindingId: "local-workspace",
  credentialBindingId: null,
  executionTarget: { kind: "control", bindingId: "local-workspace" },
  capability: "workspace.command.v0",
  approvalRequirement: "perAction",
  limits: {
    timeoutMs: TOOL_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    maxArtifactBytes: 1,
  },
};

const fullAccessPolicy: ToolExecutionPolicy = {
  ...workspacePolicy,
  resourceBindingId: "local-host",
  executionTarget: { kind: "control", bindingId: "local-host" },
  capability: "host.command.v0",
};

/** Adds the selected desktop workspace's approved command tool to every scene. */
export function createConfiguredLocalWorkspaceCommandToolRuntime(
  environment: Readonly<Record<string, string | undefined>>,
): ToolRuntimePort | undefined {
  const configuredRoot = environment[CONFIGURATION_NAME];
  if (configuredRoot === undefined || configuredRoot.length === 0) {
    return undefined;
  }
  return createLocalWorkspaceCommandToolRuntime(configuredRoot, environment);
}

export function createLocalWorkspaceCommandToolRuntime(
  configuredRoot: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ToolRuntimePort {
  const root = workspaceRoot(configuredRoot);
  let commandQueue: Promise<void> = Promise.resolve();
  const broker = (sandboxMode: LocalCommandSandboxMode) => {
    const handler: ToolHandler = (invocation, signal) => {
      const execute = () =>
        executeCommand(root, environment, invocation, signal, sandboxMode);
      const result = commandQueue.then(execute, execute);
      commandQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    const selectedPolicy =
      sandboxMode === FULL_ACCESS_SANDBOX_MODE
        ? fullAccessPolicy
        : workspacePolicy;
    return new InMemoryToolBroker(
      [definition],
      new Map([["function:workspace_run_command", handler]]),
      new Map([["function:workspace_run_command", selectedPolicy]]),
    );
  };
  const workspaceRuntime = broker(WORKSPACE_SANDBOX_MODE);
  const fullAccessRuntime = broker(FULL_ACCESS_SANDBOX_MODE);
  return {
    definitions: () => workspaceRuntime.definitions(),
    retainedExecutionResults: (query) => {
      const results = workspaceRuntime.retainedExecutionResults(query);
      return results.length >= query.limit
        ? results
        : [
            ...results,
            ...fullAccessRuntime.retainedExecutionResults({
              ...query,
              limit: query.limit - results.length,
            }),
          ];
    },
    executionPolicy: (kind, name, context?: ToolExecutionPolicyContext) =>
      runtimeForPolicyContext(
        workspaceRuntime,
        fullAccessRuntime,
        context,
      ).executionPolicy(kind, name),
    execute: (command, signal) =>
      runtimeForCommand(workspaceRuntime, fullAccessRuntime, command).execute(
        command,
        signal,
      ),
    reserveExecution: (command, signal) =>
      runtimeForCommand(
        workspaceRuntime,
        fullAccessRuntime,
        command,
      ).reserveExecution?.(command, signal),
    reconcile: (command, signal) =>
      runtimeForCommand(workspaceRuntime, fullAccessRuntime, command).reconcile(
        command,
        signal,
      ),
    cancel: (command, signal) =>
      runtimeForCommand(workspaceRuntime, fullAccessRuntime, command).cancel(
        command,
        signal,
      ),
    readRetainedExecutionResult: (lookup) =>
      runtimeForCommand(
        workspaceRuntime,
        fullAccessRuntime,
        lookup,
      ).readRetainedExecutionResult?.(lookup) ?? null,
    acknowledgeExecutionResult: (acknowledgement) =>
      runtimeForCommand(
        workspaceRuntime,
        fullAccessRuntime,
        acknowledgement,
      ).acknowledgeExecutionResult?.(acknowledgement),
  };
}

function runtimeForPolicyContext(
  workspaceRuntime: ToolRuntimePort,
  fullAccessRuntime: ToolRuntimePort,
  context: ToolExecutionPolicyContext | undefined,
): ToolRuntimePort {
  return context?.sandboxMode === FULL_ACCESS_SANDBOX_MODE
    ? fullAccessRuntime
    : workspaceRuntime;
}

function runtimeForCommand(
  workspaceRuntime: ToolRuntimePort,
  fullAccessRuntime: ToolRuntimePort,
  command: Pick<ToolExecutionCommand, "actionIntent">,
): ToolRuntimePort {
  return command.actionIntent.capability === fullAccessPolicy.capability
    ? fullAccessRuntime
    : workspaceRuntime;
}

async function executeCommand(
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
  invocation: ToolInvocation,
  signal: AbortSignal,
  sandboxMode: LocalCommandSandboxMode,
) {
  let input: ReturnType<typeof commandInput>;
  let cwd: ReturnType<typeof workspaceDirectory>;
  try {
    input = commandInput(invocation.input);
    cwd = workspaceDirectory(root, input.cwd);
  } catch (error) {
    if (
      error instanceof ToolBrokerError &&
      (error.code === "local_workspace_command_input_invalid" ||
        error.code === "local_workspace_command_cwd_invalid")
    ) {
      return commandError(error.code);
    }
    throw error;
  }
  let result: Awaited<ReturnType<typeof runBoundedShell>>;
  try {
    result = await runBoundedShell(
      input.command,
      cwd.path,
      input.timeoutSeconds,
      commandEnvironment(environment),
      signal,
      root,
      sandboxMode,
    );
  } catch (error) {
    if (
      error instanceof ToolBrokerError &&
      error.code === "local_workspace_sandbox_unavailable"
    ) {
      return commandError(error.code);
    }
    throw error;
  }
  return {
    output: JSON.stringify({
      cwd: cwd.virtualPath,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    }),
    workspaceChanges: {
      schemaVersion: "crewon.workspace-change-summary.v0" as const,
      paths: [],
      additions: 0,
      deletions: 0,
      statsComplete: false,
    },
  };
}

function commandError(code: string) {
  return {
    output: JSON.stringify({ error: code }),
    isError: true,
    workspaceChanges: {
      schemaVersion: "crewon.workspace-change-summary.v0" as const,
      paths: [],
      additions: 0,
      deletions: 0,
      statsComplete: false,
    },
  };
}

function commandInput(input: string): {
  command: string;
  cwd: string;
  timeoutSeconds: number;
} {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (cause) {
    throw new ToolBrokerError("local_workspace_command_input_invalid", {
      cause,
    });
  }
  if (!isPlainObject(value)) {
    throw new ToolBrokerError("local_workspace_command_input_invalid");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.some(
      (key) => key !== "command" && key !== "cwd" && key !== "timeoutSeconds",
    ) ||
    typeof value.command !== "string" ||
    value.command.trim().length === 0 ||
    Buffer.byteLength(value.command) > MAX_COMMAND_BYTES ||
    value.command.includes("\0") ||
    (value.cwd !== undefined && typeof value.cwd !== "string") ||
    (value.timeoutSeconds !== undefined &&
      (!Number.isSafeInteger(value.timeoutSeconds) ||
        Number(value.timeoutSeconds) < 1 ||
        Number(value.timeoutSeconds) > MAX_TIMEOUT_SECONDS))
  ) {
    throw new ToolBrokerError("local_workspace_command_input_invalid");
  }
  return {
    command: value.command,
    cwd: virtualWorkspaceDirectory(value.cwd ?? VIRTUAL_ROOT),
    timeoutSeconds: Number(value.timeoutSeconds ?? MAX_TIMEOUT_SECONDS),
  };
}

function virtualWorkspaceDirectory(value: string): string {
  if (value === "." || value === "./") {
    return VIRTUAL_ROOT;
  }
  return value.startsWith("./") ? `${VIRTUAL_ROOT}/${value.slice(2)}` : value;
}

function workspaceRoot(value: string): string {
  if (value.trim() !== value || !isAbsolute(value) || value.includes("\0")) {
    throw new Error("CREWON_DESKTOP_WORKSPACE_ROOT_invalid");
  }
  let canonical: string;
  try {
    canonical = realpathSync(value);
  } catch (cause) {
    throw new Error("CREWON_DESKTOP_WORKSPACE_ROOT_invalid", { cause });
  }
  if (!statSync(canonical).isDirectory()) {
    throw new Error("CREWON_DESKTOP_WORKSPACE_ROOT_invalid");
  }
  return canonical;
}

function workspaceDirectory(
  root: string,
  virtualPath: string,
): { path: string; virtualPath: string } {
  if (
    virtualPath !== VIRTUAL_ROOT &&
    !virtualPath.startsWith(`${VIRTUAL_ROOT}/`)
  ) {
    throw new ToolBrokerError("local_workspace_command_cwd_invalid");
  }
  const segments = virtualPath
    .slice(VIRTUAL_ROOT.length)
    .split("/")
    .filter(Boolean);
  if (
    virtualPath.includes("\0") ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new ToolBrokerError("local_workspace_command_cwd_invalid");
  }
  let path: string;
  try {
    path = realpathSync(resolve(root, ...segments));
  } catch (cause) {
    throw new ToolBrokerError("local_workspace_command_cwd_invalid", {
      cause,
    });
  }
  const fromRoot = relative(root, path);
  if (
    (fromRoot !== "" && fromRoot.startsWith(`..${sep}`)) ||
    fromRoot === ".." ||
    isAbsolute(fromRoot) ||
    !statSync(path).isDirectory()
  ) {
    throw new ToolBrokerError("local_workspace_command_cwd_invalid");
  }
  return {
    path,
    virtualPath:
      fromRoot === ""
        ? VIRTUAL_ROOT
        : `${VIRTUAL_ROOT}/${fromRoot.split(sep).join("/")}`,
  };
}

function commandEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    "APPDATA",
    "CI",
    "COLORTERM",
    "COMSPEC",
    "ELECTRON_RUN_AS_NODE",
    "FORCE_COLOR",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOCALAPPDATA",
    "LOGNAME",
    "NO_COLOR",
    "PATH",
    "PATHEXT",
    "PNPM_HOME",
    "SHELL",
    "SystemRoot",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "USER",
    "USERPROFILE",
  ]) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function runBoundedShell(
  command: string,
  cwd: string,
  timeoutSeconds: number,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
  workspaceRoot: string,
  sandboxMode: LocalCommandSandboxMode,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("local_workspace_command_aborted"));
      return;
    }
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const args =
      process.platform === "win32"
        ? ["/D", "/S", "/C", command]
        : ["-lc", command];
    let launch: Readonly<{ executable: string; args: readonly string[] }>;
    try {
      launch = commandLaunch(
        shell,
        args,
        cwd,
        workspaceRoot,
        environment,
        sandboxMode,
      );
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawn(launch.executable, launch.args, {
      cwd,
      detached: process.platform !== "win32",
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    const collect = (target: Buffer[], chunk: Buffer, total: number) => {
      const remaining = Math.max(0, MAX_COMMAND_OUTPUT_BYTES - total);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      return total + chunk.byteLength;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = collect(stderr, chunk, stderrBytes);
    });
    const terminate = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutSeconds * 1_000);
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => terminate();
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      // The shell may have started descendants that outlive it. The detached
      // process group remains ours to clean up after the command completes.
      if (process.platform !== "win32") terminate();
      if (signal.aborted) {
        reject(signal.reason ?? new Error("local_workspace_command_aborted"));
        return;
      }
      resolveRun({
        exitCode: timedOut ? 124 : (code ?? 128),
        stdout: boundedStream(stdout, stdoutBytes, "stdout"),
        stderr: boundedStream(stderr, stderrBytes, "stderr"),
      });
    });
  });
}

function commandLaunch(
  shell: string,
  shellArgs: readonly string[],
  cwd: string,
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv,
  sandboxMode: LocalCommandSandboxMode,
): Readonly<{ executable: string; args: readonly string[] }> {
  if (sandboxMode === FULL_ACCESS_SANDBOX_MODE) {
    return { executable: shell, args: shellArgs };
  }
  const temporaryRoot = sandboxTemporaryRoot(environment);
  if (process.platform === "darwin") {
    const sandboxExecutable = "/usr/bin/sandbox-exec";
    if (!existsSync(sandboxExecutable)) {
      throw new ToolBrokerError("local_workspace_sandbox_unavailable");
    }
    const parameters = ["-D", `WORKSPACE_ROOT=${workspaceRoot}`];
    if (temporaryRoot !== null) {
      parameters.push("-D", `TEMP_ROOT=${temporaryRoot}`);
    }
    return {
      executable: sandboxExecutable,
      args: [
        ...parameters,
        "-p",
        macWorkspaceSandboxProfile(temporaryRoot !== null),
        shell,
        ...shellArgs,
      ],
    };
  }
  if (process.platform === "linux") {
    const bubblewrap = ["/usr/bin/bwrap", "/bin/bwrap"].find(existsSync);
    if (bubblewrap === undefined) {
      throw new ToolBrokerError("local_workspace_sandbox_unavailable");
    }
    const writableMounts = ["--bind", workspaceRoot, workspaceRoot];
    if (temporaryRoot !== null && !isPathInside(workspaceRoot, temporaryRoot)) {
      writableMounts.push("--bind", temporaryRoot, temporaryRoot);
    }
    return {
      executable: bubblewrap,
      args: [
        "--die-with-parent",
        "--new-session",
        "--unshare-net",
        "--ro-bind",
        "/",
        "/",
        ...writableMounts,
        "--chdir",
        cwd,
        shell,
        ...shellArgs,
      ],
    };
  }
  throw new ToolBrokerError("local_workspace_sandbox_unavailable");
}

function macWorkspaceSandboxProfile(hasTemporaryRoot: boolean): string {
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow file-read*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    `(allow file-write* (subpath (param \"WORKSPACE_ROOT\"))${
      hasTemporaryRoot ? ' (subpath (param "TEMP_ROOT"))' : ""
    })`,
  ].join(" ");
}

function sandboxTemporaryRoot(environment: NodeJS.ProcessEnv): string | null {
  for (const name of ["TMPDIR", "TEMP", "TMP"] as const) {
    const candidate = environment[name];
    if (candidate === undefined || !isAbsolute(candidate)) continue;
    try {
      const canonical = realpathSync(candidate);
      if (statSync(canonical).isDirectory()) return canonical;
    } catch {
      continue;
    }
  }
  return null;
}

function isPathInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) &&
      fromRoot !== ".." &&
      !isAbsolute(fromRoot))
  );
}

function boundedStream(
  chunks: readonly Buffer[],
  totalBytes: number,
  stream: "stdout" | "stderr",
): string {
  const value = Buffer.concat(chunks).toString("utf8");
  return totalBytes > MAX_COMMAND_OUTPUT_BYTES
    ? `${value}\n[${stream} truncated]`
    : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
