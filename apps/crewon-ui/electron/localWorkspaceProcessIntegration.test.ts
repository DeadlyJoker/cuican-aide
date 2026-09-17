import { spawn as realSpawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  LocalWorkspaceAuthority,
  LocalWorkspaceSandbox,
} from "./localWorkspace.ts";
import { withWorkspaceProcesses } from "./localWorkspaceProcesses.ts";

const spawned = vi.hoisted(() => ({ pids: [] as number[] }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof realSpawn>) => {
      const child = actual.spawn(...args);
      if (child.pid !== undefined) {
        const pid = child.pid;
        spawned.pids.push(pid);
        child.once("close", () => {
          const index = spawned.pids.indexOf(pid);
          if (index >= 0) spawned.pids.splice(index, 1);
        });
      }
      return child;
    }) as typeof realSpawn,
  };
});

const roots: string[] = [];
afterEach(() => {
  // Only detached groups created by this test's actual production runner.
  for (const pid of spawned.pids) {
    try {
      process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  spawned.pids.length = 0;
  roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
  roots.length = 0;
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "crewon-process-lifecycle-"));
  roots.push(root);
  return {
    root,
    sandbox: new LocalWorkspaceSandbox(
      new LocalWorkspaceAuthority(join(root, "state"), root),
    ),
  };
}
function quote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
async function expectGone(pid: number) {
  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      },
      { timeout: 3_000, interval: 20 },
    )
    .toBe(true);
}

it.skipIf(process.platform === "win32")(
  "times out a real native command whose process and descendant both ignore SIGTERM",
  async () => {
    const { root, sandbox: native } = sandbox();
    const pidFile = join(root, "owned-pids.json");
    const fixture = `
    const cp = require('node:child_process'), fs = require('node:fs');
    process.on('SIGTERM', () => {});
    const child = cp.spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 5000);"], {stdio:['ignore','pipe','inherit']});
    child.stdout.once('data', () => fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid])));
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(0), 5000);
  `;
    const started = performance.now();
    const result = await native.runCommand({
      command: `${quote(process.execPath)} -e ${quote(fixture)}`,
      timeoutSeconds: 1,
    });
    expect(result).toMatchObject({ cwd: "/workspace", exitCode: 124 });
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(existsSync(pidFile)).toBe(true);
    for (const pid of JSON.parse(readFileSync(pidFile, "utf8")) as number[])
      await expectGone(pid);
    await expect(
      native.runCommand({ command: "printf recovered" }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "recovered" });
  },
  8_000,
);

it.skipIf(process.platform === "win32").each(["inherit", "ignore"] as const)(
  "cleans background descendants after a successful parent exit with %s pipes",
  async (stdio) => {
    const { root } = sandbox();
    const pidFile = join(root, "background-pid");
    const fixture = `
    const cp = require('node:child_process'), fs = require('node:fs');
    const code = "require('node:fs').writeFileSync(" + ${JSON.stringify(JSON.stringify(pidFile))} + ", String(process.pid)); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 5000);";
    cp.spawn(process.execPath, ['-e', code], {stdio:${JSON.stringify(stdio)}});
    const poll = setInterval(() => { if (fs.existsSync(${JSON.stringify(pidFile)})) process.exit(0); }, 5);
  `;
    const result = await withWorkspaceProcesses((run) =>
      run({
        command: process.execPath,
        args: ["-e", fixture],
        cwd: root,
        timeoutMs: 2_000,
      }),
    );
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    await expectGone(Number(readFileSync(pidFile, "utf8")));
  },
  6_000,
);

it("keeps real large output bounded and recovers slots after repeated missing executables", async () => {
  const { root } = sandbox();
  for (let i = 0; i < 12; i++) {
    await expect(
      withWorkspaceProcesses((run) =>
        run({ command: join(root, "missing"), args: [], cwd: root }),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    // An error may precede close. Yield for the actual close without pretending
    // the rejected caller has already released its physical admission.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const result = await withWorkspaceProcesses((run) =>
    run({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('x'.repeat(1024*1024)); process.stderr.write('y'.repeat(1024*1024));",
      ],
      cwd: root,
    }),
  );
  expect(result).toEqual({
    exitCode: 0,
    stdout: "x".repeat(16 * 1024),
    stderr: "y".repeat(16 * 1024),
    stdoutTruncated: true,
    stderrTruncated: true,
    timedOut: false,
  });
});
