import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import {
  withWorkspaceProcesses,
  type WorkspaceProcessRunner,
} from "./localWorkspaceProcesses.ts";

class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 10_000 + children.length;
  kill = vi.fn(() => true);
  closed = false;
  close(code: number | null = 0) {
    if (this.closed) return;
    this.closed = true;
    this.emit("exit", code, null);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, null);
  }
}
const children: Child[] = [];
const request = { command: "git", args: ["status"], cwd: "/workspace" };
const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
)!;

beforeEach(() => {
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "darwin",
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.spyOn(process, "kill").mockReturnValue(true);
  mocks.spawn.mockReset();
  mocks.spawn.mockImplementation(() => {
    const child = new Child();
    children.push(child);
    return child;
  });
});
afterEach(async () => {
  children.forEach((child) => child.close());
  await Promise.resolve();
  await Promise.resolve();
  children.length = 0;
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("native workspace process ownership", () => {
  it("bounds both output streams and removes stream listeners and timers on close", async () => {
    const pending = withWorkspaceProcesses((run) =>
      run({ ...request, maximumOutputBytes: 128 }),
    );
    const child = children[0]!;
    for (let i = 0; i < 2_000; i++) {
      child.stdout.write(Buffer.from("abc"));
      child.stderr.write(Buffer.from("xyz"));
    }
    child.close(7);
    await expect(pending).resolves.toEqual({
      exitCode: 7,
      stdout: "abc".repeat(43).slice(0, 128),
      stderr: "xyz".repeat(43).slice(0, 128),
      stdoutTruncated: true,
      stderrTruncated: true,
      timedOut: false,
    });
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares four physical slots, retaining them after visible timeouts until close", async () => {
    const pending = Array.from({ length: 4 }, () =>
      withWorkspaceProcesses((run) => run({ ...request, timeoutMs: 10 })),
    );
    await expect(withWorkspaceProcesses((run) => run(request))).rejects.toThrow(
      "desktop_sandbox_process_capacity_exhausted",
    );
    expect(mocks.spawn).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(260);
    expect(
      (await Promise.all(pending)).every(
        (result) => result.timedOut && result.exitCode === 124,
      ),
    ).toBe(true);
    await expect(withWorkspaceProcesses((run) => run(request))).rejects.toThrow(
      "desktop_sandbox_process_capacity_exhausted",
    );
    children[0]!.close(null);
    const next = withWorkspaceProcesses((run) => run(request));
    expect(mocks.spawn).toHaveBeenCalledTimes(5);
    children[4]!.close();
    await expect(next).resolves.toMatchObject({ exitCode: 0 });
  });

  it("escalates an ignored termination signal against the owned POSIX group", async () => {
    const pending = withWorkspaceProcesses((run) =>
      run({ ...request, timeoutMs: 10 }),
    );
    const child = children[0]!;
    await vi.advanceTimersByTimeAsync(10);
    expect(process.kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    await vi.advanceTimersByTimeAsync(250);
    expect(process.kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    await expect(pending).resolves.toMatchObject({
      timedOut: true,
      exitCode: 124,
    });
    child.close(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the remaining operation deadline for the next command instead of restarting it", async () => {
    const pending = withWorkspaceProcesses(async (run) => {
      await run(request);
      return run(request);
    });
    await vi.advanceTimersByTimeAsync(20_000);
    children[0]!.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(process.kill).not.toHaveBeenCalledWith(-children[1]!.pid, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1);
    expect(process.kill).toHaveBeenCalledWith(-children[1]!.pid, "SIGTERM");
    children[1]!.close(0);
    await expect(pending).resolves.toMatchObject({
      timedOut: true,
      exitCode: 124,
    });
  });

  it("does not launch more work after the sequence has spent its deadline", async () => {
    let continueOperation!: () => void;
    const gate = new Promise<void>((resolve) => {
      continueOperation = resolve;
    });
    const pending = withWorkspaceProcesses(async (run) => {
      await run(request);
      await gate;
      return run(request);
    });
    const failure = expect(pending).rejects.toThrow(
      "desktop_sandbox_command_timeout",
    );
    children[0]!.close();
    await vi.advanceTimersByTimeAsync(30_000);
    continueOperation();
    await failure;
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("holds failed-start admission until close and clears timeout callbacks", async () => {
    const pending = Array.from({ length: 4 }, () => {
      const result = withWorkspaceProcesses((run) => run(request));
      const failure = expect(result).rejects.toThrow("spawn ENOENT");
      delete (children.at(-1)! as { pid?: number }).pid;
      children.at(-1)!.emit("error", new Error("spawn ENOENT"));
      return failure;
    });
    await Promise.all(pending);
    expect(vi.getTimerCount()).toBe(0);
    await expect(withWorkspaceProcesses((run) => run(request))).rejects.toThrow(
      "desktop_sandbox_process_capacity_exhausted",
    );
    children.forEach((child) => child.close(null));
    const next = withWorkspaceProcesses((run) => run(request));
    children.at(-1)!.close();
    await expect(next).resolves.toMatchObject({ exitCode: 0 });
  });

  it("keeps termination scheduled when an error is emitted by a live child", async () => {
    const pending = withWorkspaceProcesses((run) =>
      run({ ...request, timeoutMs: 10 }),
    );
    const failure = expect(pending).rejects.toThrow("live process error");
    const child = children[0]!;
    child.emit("error", new Error("live process error"));
    await failure;
    await vi.advanceTimersByTimeAsync(260);
    expect(process.kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    child.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases synchronous spawn failures and rejects invalid budgets before spawn", async () => {
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error("spawn invalid");
    });
    await expect(withWorkspaceProcesses((run) => run(request))).rejects.toThrow(
      "spawn invalid",
    );
    for (const maximumOutputBytes of [0, 96 * 1024 + 1, NaN]) {
      await expect(
        withWorkspaceProcesses((run) =>
          run({ ...request, maximumOutputBytes }),
        ),
      ).rejects.toThrow("desktop_sandbox_process_budget_invalid");
    }
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const next = withWorkspaceProcesses((run) => run(request));
    children[0]!.close();
    await expect(next).resolves.toMatchObject({ exitCode: 0 });
  });

  it("rejects parallel commands and escaped runners within one operation", async () => {
    let escaped!: WorkspaceProcessRunner;
    const pending = withWorkspaceProcesses(async (run) => {
      escaped = run;
      const first = run(request);
      await expect(run(request)).rejects.toThrow(
        "desktop_sandbox_process_scope_invalid",
      );
      children[0]!.close();
      return first;
    });
    await pending;
    await expect(escaped(request)).rejects.toThrow(
      "desktop_sandbox_process_scope_invalid",
    );
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("retains the Windows tree cleanup helper until its own close", async () => {
    Object.defineProperty(process, "platform", {
      ...platformDescriptor,
      value: "win32",
    });
    const pending = withWorkspaceProcesses((run) =>
      run({ ...request, timeoutMs: 10 }),
    );
    await vi.advanceTimersByTimeAsync(260);
    await expect(pending).resolves.toMatchObject({ exitCode: 124 });
    expect(mocks.spawn.mock.calls[1]![1]).toEqual([
      "/PID",
      String(children[0]!.pid),
      "/T",
      "/F",
    ]);
    children[0]!.close(null);
    const other = Array.from({ length: 3 }, () =>
      withWorkspaceProcesses((run) => run(request)),
    );
    await expect(withWorkspaceProcesses((run) => run(request))).rejects.toThrow(
      "desktop_sandbox_process_capacity_exhausted",
    );
    children[1]!.close();
    const next = withWorkspaceProcesses((run) => run(request));
    children.slice(2).forEach((child) => child.close());
    await Promise.all([...other, next]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
