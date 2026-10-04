import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

type RuntimeChild = Readonly<{
  pid: number;
  parentPid: number;
  entry: string;
  executable: string;
}>;
const execute = promisify(execFile);
/** Records bounded actual descendants and original resource entrypoints. No spawn is replaced. */
export function observePackagedRuntimeChildren(
  child: ChildProcess,
  executable: string,
  runtimeDirectory: string,
) {
  assert.ok(child.pid);
  const rootPid = child.pid;
  const seen = new Map<number, RuntimeChild>();
  let pending: Promise<void> | null = null;
  let failure: unknown;
  let closed = false;
  const entries = [
    "control-api.mjs",
    "runtime-worker.mjs",
    "runtime-release.mjs",
    "provider-model-catalog.mjs",
    "provider-settings-coordinator.mjs",
    "device-gateway.mjs",
    "local-workspace-checks-mcp.mjs",
  ].map((name) => join(runtimeDirectory, name));
  async function capture() {
    if (closed || child.exitCode !== null || child.signalCode !== null) return;
    const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,args="], {
      maxBuffer: 1024 * 1024,
      timeout: 2000,
    });
    const rows = stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
      return match
        ? [
            {
              pid: Number(match[1]),
              parentPid: Number(match[2]),
              command: match[3]!.trim(),
            },
          ]
        : [];
    });
    const parents = new Set([rootPid]);
    while (true) {
      let added = false;
      for (const row of rows)
        if (!parents.has(row.pid) && parents.has(row.parentPid)) {
          parents.add(row.pid);
          added = true;
          const entry = entries.find(
            (entry) => row.command === executable + " " + entry,
          );
          if (entry) {
            assert.ok(
              seen.size < 32 || seen.has(row.pid),
              "packaged_child_observation_limit",
            );
            seen.set(row.pid, {
              pid: row.pid,
              parentPid: row.parentPid,
              entry,
              executable,
            });
          }
        }
      if (!added) break;
    }
  }
  function record() {
    if (pending || closed) return;
    pending = capture()
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        pending = null;
      });
  }
  record();
  const timer = setInterval(record, 50);
  timer.unref();
  return {
    async close(): Promise<readonly RuntimeChild[]> {
      closed = true;
      clearInterval(timer);
      await pending;
      if (failure) throw failure;
      return Object.freeze([...seen.values()]);
    },
  };
}
