import { spawn } from "node:child_process";
import { join } from "node:path";

const MAX_ACTIVE_OPERATIONS = 4;
const MAX_OPERATION_MS = 30_000;
const TERMINATION_GRACE_MS = 250;
const MAX_OUTPUT_BYTES = 96 * 1024;
let activeOperations = 0;

export type WorkspaceProcessRequest = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs?: number;
  maximumOutputBytes?: number;
  environment?: NodeJS.ProcessEnv;
}>;

export type WorkspaceProcessResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
}>;

export type WorkspaceProcessRunner = (
  request: WorkspaceProcessRequest,
) => Promise<WorkspaceProcessResult>;

// Every sandbox instance shares admission. An operation runs one subprocess at
// a time; Git's entire sequence shares a monotonic deadline. Caller completion
// never releases a slot while its child or Windows cleanup helper is still open.
export async function withWorkspaceProcesses<T>(
  operation: (run: WorkspaceProcessRunner) => Promise<T>,
): Promise<T> {
  if (activeOperations >= MAX_ACTIVE_OPERATIONS)
    throw new Error("desktop_sandbox_process_capacity_exhausted");
  activeOperations++;
  const deadline = performance.now() + MAX_OPERATION_MS;
  let finished = false;
  let openProcesses = 0;
  let released = false;
  const release = () => {
    if (finished && openProcesses === 0 && !released) {
      released = true;
      activeOperations--;
    }
  };
  const retain = () => {
    openProcesses++;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      openProcesses--;
      release();
    };
  };
  try {
    return await operation(async (request) => {
      if (finished || openProcesses !== 0)
        throw new Error("desktop_sandbox_process_scope_invalid");
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("desktop_sandbox_command_timeout");
      const timeoutMs = request.timeoutMs ?? MAX_OPERATION_MS;
      const maximumOutputBytes = request.maximumOutputBytes ?? 16 * 1024;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > MAX_OPERATION_MS ||
        !Number.isSafeInteger(maximumOutputBytes) ||
        maximumOutputBytes < 1 ||
        maximumOutputBytes > MAX_OUTPUT_BYTES
      )
        throw new Error("desktop_sandbox_process_budget_invalid");
      return runProcess(
        request,
        Math.min(remaining, timeoutMs),
        maximumOutputBytes,
        retain,
      );
    });
  } finally {
    finished = true;
    release();
  }
}

function runProcess(
  request: WorkspaceProcessRequest,
  timeoutMs: number,
  maximumOutputBytes: number,
  retain: () => () => void,
): Promise<WorkspaceProcessResult> {
  return new Promise((resolveRun, reject) => {
    const closeLease = retain();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.environment ?? process.env,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      closeLease();
      reject(error);
      return;
    }
    // Fixed buffers bound allocations even for millions of tiny output chunks.
    let stdout = Buffer.alloc(maximumOutputBytes);
    let stderr = Buffer.alloc(maximumOutputBytes);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let windowsCleanupStarted = false;
    const collect = (target: Buffer, chunk: Buffer, current: number) => {
      if (!settled && current < maximumOutputBytes)
        chunk.copy(target, current, 0, maximumOutputBytes - current);
      return Math.min(maximumOutputBytes + 1, current + chunk.byteLength);
    };
    const onStdout = (chunk: Buffer) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes);
    };
    const onStderr = (chunk: Buffer) => {
      stderrBytes = collect(stderr, chunk, stderrBytes);
    };
    child.stdout!.on("data", onStdout);
    child.stderr!.on("data", onStderr);

    const terminate = (signal: "SIGTERM" | "SIGKILL") => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // A failed signal is not evidence of close: the physical lease stays held.
        try {
          child.kill(signal);
        } catch {
          /* close remains authoritative */
        }
      }
    };
    const terminateWindowsTree = () => {
      if (
        process.platform !== "win32" ||
        child.pid === undefined ||
        windowsCleanupStarted
      )
        return;
      windowsCleanupStarted = true;
      const closeCleanupLease = retain();
      let cleanup: ReturnType<typeof spawn>;
      try {
        cleanup = spawn(
          join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "taskkill.exe",
          ),
          ["/PID", String(child.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true, shell: false },
        );
      } catch {
        closeCleanupLease();
        terminate("SIGKILL");
        return;
      }
      const cleanupTimeout = setTimeout(() => {
        try {
          cleanup.kill("SIGKILL");
        } catch {
          /* retain until close */
        }
      }, 1_000);
      cleanup.on("error", () => terminate("SIGKILL"));
      cleanup.once("close", () => {
        clearTimeout(cleanupTimeout);
        closeCleanupLease();
      });
    };
    const result = (exitCode: number) => {
      if (settled) return;
      settled = true;
      resolveRun({
        exitCode: timedOut ? 124 : exitCode,
        stdout: stdout.toString(
          "utf8",
          0,
          Math.min(stdoutBytes, maximumOutputBytes),
        ),
        stderr: stderr.toString(
          "utf8",
          0,
          Math.min(stderrBytes, maximumOutputBytes),
        ),
        stdoutTruncated: stdoutBytes > maximumOutputBytes,
        stderrTruncated: stderrBytes > maximumOutputBytes,
        timedOut,
      });
      stdout = Buffer.alloc(0);
      stderr = Buffer.alloc(0);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") terminateWindowsTree();
      else terminate("SIGTERM");
      forceTimer = setTimeout(() => {
        terminate("SIGKILL");
        result(124);
        // A descendant may have escaped the process group while holding a pipe.
        // Stop draining late output, but retain admission until child close.
        child.stdout!.destroy();
        child.stderr!.destroy();
      }, TERMINATION_GRACE_MS);
    }, timeoutMs);
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      // A failed spawn has no process to terminate. Errors from a live child
      // (including signaling failures) must not cancel its cleanup deadline.
      if (child.pid === undefined) {
        clearTimeout(timeout);
        clearTimeout(forceTimer);
      }
      stdout = Buffer.alloc(0);
      stderr = Buffer.alloc(0);
      reject(error);
    };
    child.on("error", onError);
    child.once("exit", () => {
      // Stop background descendants even when the shell exits successfully;
      // inherited pipes must not keep this short-lived command alive forever.
      if (process.platform !== "win32") terminate("SIGKILL");
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      child.stdout!.removeListener("data", onStdout);
      child.stderr!.removeListener("data", onStderr);
      child.removeListener("error", onError);
      result(code ?? 124);
      closeLease();
    });
  });
}
