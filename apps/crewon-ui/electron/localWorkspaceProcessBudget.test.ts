import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import {
  LocalWorkspaceAuthority,
  LocalWorkspaceSandbox,
} from "./localWorkspace.ts";

class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 20_000 + children.length;
  kill = vi.fn(() => true);
  closed = false;
  close(output = "", code = 0) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.write(output);
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code);
    this.emit("close", code);
  }
}
const children: Child[] = [];
let root: string;
const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
)!;
function native() {
  return new LocalWorkspaceSandbox(
    new LocalWorkspaceAuthority(join(root, "state"), root),
  );
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crewon-process-budget-"));
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "darwin",
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.spyOn(process, "kill").mockReturnValue(true);
  mocks.spawn.mockReset().mockImplementation(() => {
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
  rmSync(root, { recursive: true, force: true });
});

it("applies one deadline to actual native Git orchestration across multiple commands", async () => {
  const pending = native().readGitSummary();
  const rejected = expect(pending).rejects.toThrow(
    "desktop_sandbox_command_timeout",
  );
  await vi.advanceTimersByTimeAsync(15_000);
  children[0]!.close("true\n");
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.spawn.mock.calls[1]![1]).toEqual([
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  await vi.advanceTimersByTimeAsync(14_999);
  children[1]!.close("a".repeat(40) + "\n");
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.spawn.mock.calls[2]![1]).toEqual([
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  await vi.advanceTimersByTimeAsync(251);
  await rejected;
  expect(mocks.spawn).toHaveBeenCalledTimes(3);
});

it("does not misreport a timed-out repository probe as a non-repository", async () => {
  const pending = native().readDiff();
  const rejected = expect(pending).rejects.toThrow(
    "desktop_sandbox_command_timeout",
  );
  await vi.advanceTimersByTimeAsync(30_250);
  await rejected;
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
});

it("shares command and Git admission across sandbox instances and resumes after close", async () => {
  const pending = Array.from({ length: 4 }, () =>
    native().runCommand({ command: "printf held", timeoutSeconds: 1 }),
  );
  await expect(native().readGitSummary()).rejects.toThrow(
    "desktop_sandbox_process_capacity_exhausted",
  );
  await vi.advanceTimersByTimeAsync(1_250);
  expect(
    (await Promise.all(pending)).every((result) => result.exitCode === 124),
  ).toBe(true);
  await expect(native().readDiff()).rejects.toThrow(
    "desktop_sandbox_process_capacity_exhausted",
  );
  children[0]!.close();
  const read = native().readGitSummary();
  children[4]!.close("", 128);
  await expect(read).resolves.toMatchObject({
    isGitRepository: false,
    statsComplete: false,
  });
});
