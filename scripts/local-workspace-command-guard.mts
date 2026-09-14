import { spawn, type ChildProcess } from "node:child_process";
import { writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type WorkspaceCommandOutcome = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  canceled: boolean;
  error: string | null;
};

/** This process owns the command group and survives an abrupt MCP parent exit. */
export async function runWorkspaceCommandGuard(): Promise<never> {
  let child: ChildProcess | null = null;
  let stopping = false,
    inputBytes = 0,
    configured = false;
  const input = Buffer.alloc(16 * 1024);
  const outcome: WorkspaceCommandOutcome = {
    exitCode: null,
    signal: null,
    timedOut: false,
    canceled: false,
    error: null,
  };
  let deadline: NodeJS.Timeout | null = null;
  const killGroup = () => {
    if (process.platform === "win32") {
      const root = process.env.SystemRoot;
      if (!root || !isAbsolute(root)) process.exit(125);
      const killer = spawn(
        join(root, "System32", "taskkill.exe"),
        ["/PID", String(process.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore", shell: false },
      );
      killer.on("error", () => process.exit(125));
      // The parent also enforces shutdown. Do not wait indefinitely on taskkill.
      setTimeout(() => process.exit(125), 1000);
    } else {
      try {
        process.kill(-process.pid, "SIGKILL");
      } catch {
        process.exit(125);
      }
    }
  };
  const stop = (reason: "completed" | "timeout" | "canceled" | "error") => {
    if (stopping) return;
    stopping = true;
    if (deadline) clearTimeout(deadline);
    clearTimeout(startup);
    outcome.timedOut = reason === "timeout";
    outcome.canceled = reason === "canceled";
    if (!child) {
      try {
        writeSync(3, JSON.stringify(outcome) + "\n");
      } catch {
        /* parent may be gone */
      }
      process.exit(0);
    }
    // Keep the guard as the live group/tree anchor until all cleanup signals are sent.
    if (process.platform !== "win32") {
      try {
        process.kill(-process.pid, "SIGTERM");
      } catch {
        /* still enforce the hard cleanup below */
      }
    }
    setTimeout(
      () => {
        try {
          writeSync(3, JSON.stringify(outcome) + "\n");
        } catch {
          /* parent may be gone */
        }
        killGroup();
      },
      reason === "completed" ? 0 : 200,
    );
  };
  const startup = setTimeout(() => {
    outcome.error = "workspace_command_guard_startup_timeout";
    stop("error");
  }, 5000);
  process.on("SIGTERM", () => stop("canceled"));
  process.on("SIGINT", () => stop("canceled"));
  process.stdin.on("end", () => stop("canceled"));
  process.stdin.on("error", () => stop("canceled"));
  process.stdin.on("data", (chunk: Buffer) => {
    if (stopping) return;
    if (configured) {
      stop("canceled");
      return;
    }
    if (inputBytes + chunk.length > input.length) {
      outcome.error = "workspace_command_guard_input_budget";
      stop("error");
      return;
    }
    chunk.copy(input, inputBytes);
    inputBytes += chunk.length;
    if (!input.subarray(0, inputBytes).includes(10)) return;
    try {
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          input.subarray(0, inputBytes),
        ),
      );
      if (
        typeof value.command !== "string" ||
        !isAbsolute(value.command) ||
        !Array.isArray(value.args) ||
        value.args.length > 32 ||
        value.args.some(
          (arg: unknown) => typeof arg !== "string" || arg.includes("\0"),
        ) ||
        typeof value.cwd !== "string" ||
        !isAbsolute(value.cwd) ||
        !Number.isSafeInteger(value.timeoutMs) ||
        value.timeoutMs < 1 ||
        value.timeoutMs > 120_000
      )
        throw new Error("workspace_command_guard_input_invalid");
      if (
        process.platform === "win32" &&
        (!process.env.SystemRoot || !isAbsolute(process.env.SystemRoot))
      )
        throw new Error("workspace_command_tree_termination_unavailable");
      configured = true;
      clearTimeout(startup);
      child = spawn(value.command, value.args, {
        cwd: value.cwd,
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", 1, 2],
      });
      deadline = setTimeout(() => stop("timeout"), value.timeoutMs);
      child.once("error", (error) => {
        outcome.error = error.message.slice(0, 512);
        stop("error");
      });
      child.once("exit", (code, signal) => {
        outcome.exitCode = code;
        outcome.signal = signal;
        stop("completed");
      });
    } catch (error) {
      outcome.error =
        error instanceof Error
          ? error.message.slice(0, 512)
          : "workspace_command_guard_input_invalid";
      stop("error");
    }
  });
  return await new Promise<never>(() => {});
}
