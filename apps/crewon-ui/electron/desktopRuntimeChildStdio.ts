import type { StdioOptions } from "node:child_process";

/** Private Node parent transport only; no renderer bridge or project authorization is installed here. */
export function desktopRuntimeChildStdio(
  input: Readonly<{
    stdin: "ignore" | "pipe";
    parentChannel: "control" | "none";
  }>,
): StdioOptions {
  return input.parentChannel === "control"
    ? [input.stdin, "pipe", "pipe", "ipc"]
    : [input.stdin, "pipe", "pipe"];
}
