import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkspaceCommandOutcome } from "./local-workspace-command-guard.mts";

const MAX_OUTPUT_BYTES = 60 * 1024;
const MAX_COMMANDS = 4;
export const WORKSPACE_COMMAND_TIMEOUT_MS = 120_000;
type Request = {
  command: string;
  args: readonly string[];
  cwd: string;
  signal: AbortSignal;
};
type Result = Omit<WorkspaceCommandOutcome, "canceled" | "error"> & {
  command: string[];
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
};

/** No waiting queue; a slot is released only after its command group has been checked. */
export function createWorkspaceCommands(
  entrypoint: string,
  options: { timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? WORKSPACE_COMMAND_TIMEOUT_MS;
  if (
    !isAbsolute(entrypoint) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > WORKSPACE_COMMAND_TIMEOUT_MS
  )
    throw new Error("workspace_command_configuration_invalid");
  const active = new Set<{ cancel: () => void; done: Promise<Result> }>();
  let closed = false,
    quarantined = false;
  return {
    async run(request: Request) {
      request.signal.throwIfAborted();
      if (closed || quarantined) throw new Error("workspace_commands_closed");
      if (active.size >= MAX_COMMANDS)
        throw new Error("workspace_command_capacity_exceeded");
      const execution = execute(entrypoint, request, timeoutMs, () => {
        quarantined = true;
      });
      active.add(execution);
      try {
        return await execution.done;
      } finally {
        active.delete(execution);
      }
    },
    async close() {
      closed = true;
      const pending = [...active];
      for (const execution of pending) execution.cancel();
      await Promise.allSettled(pending.map((execution) => execution.done));
    },
    snapshot: () => ({
      active: active.size,
      capacity: MAX_COMMANDS,
      closed,
      quarantined,
    }),
  };
}

function execute(
  entrypoint: string,
  request: Request,
  timeoutMs: number,
  quarantine: () => void,
) {
  const configuration =
    JSON.stringify({
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      timeoutMs,
    }) + "\n";
  if (Buffer.byteLength(configuration) > 16 * 1024)
    throw new Error("workspace_command_input_budget");
  const child = spawn(process.execPath, [entrypoint, "--command-guard"], {
    cwd: request.cwd,
    env: process.env,
    detached: process.platform !== "win32",
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const stdout = capture(),
    stderr = capture();
  child.stdout!.on("data", stdout.collect);
  child.stderr!.on("data", stderr.collect);
  let status = Buffer.alloc(0),
    statusOverflow = false,
    canceled = false;
  const statusPipe = child.stdio[3];
  if (!statusPipe || !("on" in statusPipe))
    throw new Error("workspace_command_status_pipe_missing");
  statusPipe.on("data", (chunk: Buffer) => {
    if (status.length + chunk.length > 4096) {
      statusOverflow = true;
      return;
    }
    status = Buffer.concat([status, chunk]);
  });
  let settle: (error?: Error) => void = () => {};
  let force: NodeJS.Timeout | null = null;
  const cancel = () => {
    canceled = true;
    child.stdin!.destroy(); // EOF reaches the guard even if this MCP process disappears.
    force ??= setTimeout(
      () => settle(new Error("workspace_command_shutdown_timeout")),
      2000,
    );
  };
  const done = new Promise<Result>((resolve, reject) => {
    let settled = false;
    const deadline = setTimeout(
      () => settle(new Error("workspace_command_guard_deadline")),
      timeoutMs + 5000,
    );
    const onAbort = () => cancel();
    request.signal.addEventListener("abort", onAbort, { once: true });
    settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (force) clearTimeout(force);
      request.signal.removeEventListener("abort", onAbort);
      child.stdin!.destroy();
      void (async () => {
        const cleanup = await terminateOwnedGroup({
          pid: child.pid,
          exited: child.exitCode !== null || child.signalCode !== null,
          exitCode: child.exitCode,
        });
        child.stdout!.destroy();
        child.stderr!.destroy();
        statusPipe.destroy();
        if (!cleanup.gone) {
          quarantine();
          throw new Error("workspace_command_cleanup_unconfirmed", {
            cause: cleanup.cause,
          });
        }
        if (error) throw error;
        if (canceled || request.signal.aborted)
          throw new Error("workspace_command_aborted");
        if (statusOverflow) throw new Error("workspace_command_status_budget");
        let outcome: WorkspaceCommandOutcome;
        try {
          outcome = JSON.parse(status.toString("utf8"));
        } catch {
          throw new Error("workspace_command_guard_result_missing");
        }
        if (
          !outcome ||
          (outcome.exitCode !== null &&
            !Number.isSafeInteger(outcome.exitCode)) ||
          (outcome.signal !== null &&
            (typeof outcome.signal !== "string" ||
              !/^SIG[A-Z0-9]+$/.test(outcome.signal))) ||
          typeof outcome.timedOut !== "boolean" ||
          typeof outcome.canceled !== "boolean" ||
          (outcome.error !== null && typeof outcome.error !== "string")
        )
          throw new Error("workspace_command_guard_result_invalid");
        if (outcome.canceled) throw new Error("workspace_command_aborted");
        return {
          command: [request.command, ...request.args],
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          timedOut: outcome.timedOut,
          stdout: stdout.text(),
          stderr: outcome.error ?? stderr.text(),
          outputTruncated: stdout.truncated() || stderr.truncated(),
        };
      })().then(resolve, reject);
    };
    child.once("error", (error) => settle(error));
    child.once("exit", () => {
      // A killed guard may leave descendants holding stdout/stderr open, so
      // waiting only for 'close' would postpone cleanup until the command timeout.
      force ??= setTimeout(
        () => settle(new Error("workspace_command_guard_exit_stream_deadline")),
        250,
      );
    });
    child.once("close", () => settle());
    child.stdin!.on("error", () => {}); // Spawn/exit handling owns the outcome.
    child.stdin!.write(configuration);
    if (request.signal.aborted) cancel();
  });
  return { cancel, done };
}

function capture() {
  const bytes = Buffer.alloc(MAX_OUTPUT_BYTES);
  let length = 0,
    truncated = false;
  return {
    collect(chunk: Buffer) {
      const copied = Math.min(chunk.length, bytes.length - length);
      chunk.copy(bytes, length, 0, copied);
      length += copied;
      truncated ||= copied < chunk.length;
    },
    text: () => bytes.subarray(0, length).toString("utf8"),
    truncated: () => truncated,
  };
}

async function terminateOwnedGroup({
  pid,
  exited,
  exitCode,
}: {
  pid: number | undefined;
  exited: boolean;
  exitCode: number | null;
}): Promise<{ gone: boolean; cause?: unknown }> {
  if (pid === undefined) return { gone: true };
  if (process.platform === "win32") {
    // The guard is the stable tree root; never target a recycled command PID.
    if (exited)
      return {
        gone: exitCode !== 125,
        cause:
          exitCode === 125
            ? new Error("workspace_command_guard_cleanup_failed")
            : undefined,
      };
    const root = process.env.SystemRoot;
    if (!root || !isAbsolute(root))
      return {
        gone: false,
        cause: new Error("workspace_command_tree_termination_unavailable"),
      };
    return await new Promise((resolve) => {
      const killer = spawn(
        join(root, "System32", "taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"],
        { shell: false, windowsHide: true, stdio: "ignore" },
      );
      const timer = setTimeout(() => {
        killer.kill();
        resolve({
          gone: false,
          cause: new Error("workspace_command_tree_termination_timeout"),
        });
      }, 1000);
      killer.once("error", (error) => {
        clearTimeout(timer);
        resolve({ gone: false, cause: error });
      });
      killer.once("close", (code) => {
        clearTimeout(timer);
        resolve({
          gone: code === 0,
          cause:
            code === 0
              ? undefined
              : new Error("workspace_command_tree_termination_failed"),
        });
      });
    });
  }
  const deadline = performance.now() + 1000;
  let signaled = false;
  let lastError: unknown = new Error("workspace_command_group_still_present");
  while (performance.now() < deadline) {
    if (!signaled) {
      try {
        process.kill(-pid, "SIGKILL");
        signaled = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH")
          return { gone: true };
        lastError = error;
      }
    }
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH")
        return { gone: true };
      // macOS can transiently report EPERM while killed group members are reaped.
      // It is not proof of exit: keep checking within the original cleanup budget.
      lastError = error;
    }
    await delay(20);
  }
  return { gone: false, cause: lastError };
}
