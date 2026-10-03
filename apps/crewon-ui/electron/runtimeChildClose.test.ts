import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { expect, it } from "vitest";
import {
  isRuntimeChildTerminal,
  observeRuntimeChildClose,
  waitForRuntimeChildTerminalBefore,
} from "./runtimeChildClose.ts";
import { settleDesktopRuntimeChildren } from "./desktopExtensionRuntime.ts";
import { terminateRuntimeChild } from "./runtimeSupervisor.ts";

it("retains an exited Native child until close, including timed-out shutdown", async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill() {
      throw new Error("must not signal an exited PID");
    },
  }) as unknown as ChildProcess;
  observeRuntimeChildClose(child);
  Object.assign(child, { exitCode: 0 });
  child.emit("exit", 0, null);
  expect(isRuntimeChildTerminal(child)).toBe(false);
  const incomplete = await settleDesktopRuntimeChildren([child], (current) =>
    terminateRuntimeChild(current, { gracefulExitMs: 1, forcedExitMs: 1 }),
  );
  expect(incomplete.terminal.size).toBe(0);
  expect(incomplete.failures).toHaveLength(1);
  expect(incomplete.failures[0]).toMatchObject({
    message: "runtime_child_shutdown_timeout",
  });
  child.emit("close", 0, null);
  await expect(terminateRuntimeChild(child)).resolves.toBeUndefined();
  expect(isRuntimeChildTerminal(child)).toBe(true);
});

it("does not retire a real Node child while inherited output pipes remain open", async () => {
  // The descendant only holds inherited stdio briefly. It neither reads Native
  // files nor executes a plugin; this is a physical close regression fixture.
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {spawn} from 'node:child_process';
       const descendant=spawn(process.execPath,['-e','setTimeout(()=>{}, 500)'],
         {stdio:['ignore',process.stdout,process.stderr]});
       descendant.unref();`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  observeRuntimeChildClose(child);
  const physicalClose = once(child, "close");
  child.stdout?.resume();
  child.stderr?.resume();
  try {
    await once(child, "exit");
    expect(child.exitCode).toBe(0);
    expect(isRuntimeChildTerminal(child)).toBe(false);
    await expect(
      waitForRuntimeChildTerminalBefore(child, 10),
    ).resolves.toBeNull();
    await terminateRuntimeChild(child, {
      gracefulExitMs: 2_000,
      forcedExitMs: 1_000,
    });
    expect(isRuntimeChildTerminal(child)).toBe(true);
    expect(child.signalCode).toBeNull();
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await physicalClose;
  }
});
