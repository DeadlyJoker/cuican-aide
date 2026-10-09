import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InstalledProcessChild } from "../../runtime-worker/src/installed-plugin-worker-process.test-support.ts";

const repository = fileURLToPath(new URL("../../..", import.meta.url));

/** Actual source or explicitly supplied packaged entrypoints; production handlers are not replaced. */
export function startFullAppProcess(
  entry: "control" | "bff",
  environment: NodeJS.ProcessEnv,
  options: Readonly<{ entrypointPath?: string }> = {},
): InstalledProcessChild {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      options.entrypointPath ??
        join(
          repository,
          `apps/${entry === "control" ? "control-api" : "web-bff"}/src/main.ts`,
        ),
    ],
    {
      cwd: repository,
      env: { ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end();
  let stdout = "",
    stderr = "",
    finished = false;
  const capture = (channel: "stdout" | "stderr", chunk: Buffer) => {
    if (channel === "stdout") stdout += chunk.toString("utf8");
    else stderr += chunk.toString("utf8");
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 256 * 1024)
      child.kill("SIGKILL");
  };
  child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((accept, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      finished = true;
      accept({ code, signal });
    });
  });
  void completion.catch(() => {});
  return {
    child,
    completion,
    stdout: () => stdout,
    stderr: () => stderr,
    finished: () => finished,
  };
}

/** Physical process/stdout termination precedes filesystem and database fixture cleanup. */
export async function stopFullAppProcess(
  child: InstalledProcessChild,
): Promise<void> {
  if (!child.finished()) child.child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      child.completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("full_app_child_shutdown_timeout")),
          15_000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(result.code, 0, child.stderr());
    assert.equal(result.signal, null, child.stderr());
  } catch (error) {
    if (!child.finished()) child.child.kill("SIGKILL");
    await child.completion.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fullAppPortClosed(port: number): Promise<boolean> {
  return new Promise((accept) => {
    const socket = connect({ host: "127.0.0.1", port });
    let completed = false;
    const done = (closed: boolean) => {
      if (completed) return;
      completed = true;
      socket.destroy();
      accept(closed);
    };
    socket.once("connect", () => done(false));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      done(error.code === "ECONNREFUSED"),
    );
    socket.setTimeout(1000, () => done(false));
  });
}
