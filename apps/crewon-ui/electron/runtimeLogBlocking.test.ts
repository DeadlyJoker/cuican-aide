import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

type Reply = {
  kind: string;
  outputs?: Record<
    string,
    { queuedBytes: number; inFlightBytes: number; discardedBytes: number }
  >;
  writer?: { pid: number; inFlightWrites: number; inFlightBytes: number };
  shared?: boolean;
};

async function probe(
  mode: string,
  inspect: (
    child: ChildProcess,
    next: (kind: string, timeout?: number) => Promise<Reply>,
  ) => Promise<number | null>,
) {
  const directory = mkdtempSync(join(tmpdir(), "crewon-log-blocking-"));
  const paths = [join(directory, "stdout"), join(directory, "stderr")];
  for (const path of paths) expect(spawnSync("mkfifo", [path]).status).toBe(0);
  const fds = paths.map((path) => openSync(path, constants.O_RDWR));
  const ownership = join(directory, "ownership.json");
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(
        new URL("./runtimeLogBlocking.test-support.ts", import.meta.url),
      ),
      mode,
      ownership,
    ],
    {
      stdio: ["ignore", fds[0], fds[1], "ipc", fds[0], fds[1]],
    },
  );
  const replies: Reply[] = [];
  child.on("message", (value) => replies.push(value as Reply));
  const closed = once(child, "close");
  let helper: number | null = null;
  const deadline = setTimeout(() => child.kill("SIGKILL"), 8000);
  const next = async (kind: string, timeout = 2000) => {
    const end = performance.now() + timeout;
    while (performance.now() < end) {
      const index = replies.findIndex((reply) => reply.kind === kind);
      if (index >= 0) return replies.splice(index, 1)[0];
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("host_exited");
      await delay(10);
    }
    throw new Error("reply_timeout");
  };
  try {
    await next("started");
    helper = await inspect(child, next);
    if (mode === "legacy" || mode === "crash") child.kill("SIGKILL");
    else child.send("stop");
    const result = await closed;
    if (mode !== "legacy" && mode !== "crash")
      expect(result).toEqual([0, null]);
    if (mode === "crash") expect(result).toEqual([null, "SIGKILL"]);
    if (helper !== null) {
      let gone = false;
      for (let n = 0; n < 100; n++) {
        try {
          process.kill(helper, 0);
        } catch {
          gone = true;
          break;
        }
        await delay(10);
      }
      expect(gone, "helper must exit even while its output is blocked").toBe(
        true,
      );
    }
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await closed;
    // The normal path must have reaped it; this only contains a failing test.
    helper ??= replies.find((reply) => reply.writer)?.writer?.pid ?? null;
    try {
      const owned = JSON.parse(readFileSync(ownership, "utf8"));
      if (
        owned.host === child.pid &&
        Number.isSafeInteger(owned.helper) &&
        owned.helper > 0
      )
        helper ??= owned.helper;
    } catch {}
    if (helper !== null) {
      try {
        process.kill(helper, "SIGKILL");
      } catch {}
    }
    for (const fd of fds) closeSync(fd);
    rmSync(directory, { recursive: true });
  }
}

it.skipIf(process.platform === "win32")(
  "reproduces main-loop blocking with the original synchronous destination",
  async () => {
    await probe("legacy", async (child, next) => {
      await delay(100);
      child.send("ping");
      await expect(next("pong", 250)).rejects.toThrow("reply_timeout");
      return null;
    });
  },
  10000,
);

for (const mode of ["process", "synchronous", "shared", "crash"]) {
  it.skipIf(process.platform === "win32")(
    `${mode}: stays responsive through 64 MiB of logs and reaps the blocked writer on parent exit`,
    async () => {
      await probe(mode, async (child, next) => {
        await next("flooded");
        child.send("ping");
        const reply = await next("pong");
        for (const output of Object.values(reply.outputs!)) {
          expect(output.queuedBytes).toBeLessThanOrEqual(128 * 1024);
          expect(output.inFlightBytes).toBeLessThanOrEqual(16 * 1024);
          expect(output.discardedBytes).toBeGreaterThan(10 * 1024 * 1024);
        }
        expect(reply.writer!.inFlightWrites).toBeLessThanOrEqual(2);
        expect(reply.writer!.inFlightBytes).toBeLessThanOrEqual(32 * 1024);
        if (mode === "shared") expect(reply.shared).toBe(true);
        return reply.writer!.pid;
      });
    },
    10000,
  );
}
