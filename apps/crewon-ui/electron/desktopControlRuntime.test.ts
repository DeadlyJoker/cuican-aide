import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  desktopControlHistoricalEnvironment,
  replaceDesktopControlRuntime,
} from "./desktopControlRuntime.ts";
import { terminateRuntimeChild } from "./runtimeSupervisor.ts";

const environment = {
  CREWON_EXTENSIONS_ENABLED: "1",
  CREWON_EXTENSION_HOST_ORIGIN: "http://127.0.0.1:1111",
  CREWON_EXTENSION_HOST_TOKEN: "a".repeat(64),
};
const peer = {
  origin: "http://127.0.0.1:2222",
  token: "b".repeat(64),
  deadlineMs: 1000,
};

it("passes only bounded historical peers to Control and removes stale peer input", () => {
  const ambient = {
    ...environment,
    CREWON_EXTENSION_HISTORICAL_HOSTS_JSON: "stale",
  };
  const result = desktopControlHistoricalEnvironment({
    environment: ambient,
    peers: [peer],
  });
  expect(JSON.parse(result.CREWON_EXTENSION_HISTORICAL_HOSTS_JSON!)).toEqual([
    peer,
  ]);
  expect(result.CREWON_EXTENSION_HOST_TOKEN).toBe(
    environment.CREWON_EXTENSION_HOST_TOKEN,
  );
  expect(ambient.CREWON_EXTENSION_HISTORICAL_HOSTS_JSON).toBe("stale");
  expect(
    desktopControlHistoricalEnvironment({ environment: ambient, peers: [] })
      .CREWON_EXTENSION_HISTORICAL_HOSTS_JSON,
  ).toBeUndefined();
});

it.each([
  { ...peer, origin: environment.CREWON_EXTENSION_HOST_ORIGIN },
  { ...peer, origin: "https://external.example.com" },
  { ...peer, token: "short" },
  { ...peer, deadlineMs: 30_001 },
])(
  "rejects invalid native peer input before it can update Control: %j",
  (invalid) => {
    expect(() =>
      desktopControlHistoricalEnvironment({ environment, peers: [invalid] }),
    ).toThrow();
  },
);

it("rejects duplicates, capacity overflow and historical authority while plugins are off", () => {
  expect(() =>
    desktopControlHistoricalEnvironment({ environment, peers: [peer, peer] }),
  ).toThrow();
  expect(() =>
    desktopControlHistoricalEnvironment({
      environment,
      peers: Array.from({ length: 5 }, (_, i) => ({
        ...peer,
        origin: `http://127.0.0.1:${3000 + i}`,
      })),
    }),
  ).toThrow();
  expect(() =>
    desktopControlHistoricalEnvironment({ environment: {}, peers: [peer] }),
  ).toThrow();
});

function child(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
  }) as unknown as ChildProcess;
}

it("never starts a duplicate Control when termination fails or reports success without exit", async () => {
  const current = { control: child(), worker: child() };
  const spawnControl = vi.fn(() => child());
  const input = {
    current,
    environment,
    signal: new AbortController().signal,
    spawnControl,
    trackChild: vi.fn(),
    waitForReady: vi.fn(async () => undefined),
  };
  await expect(
    replaceDesktopControlRuntime({
      ...input,
      terminateControl: async () => {
        throw new Error("still alive");
      },
    }),
  ).rejects.toThrow("still alive");
  await expect(
    replaceDesktopControlRuntime({
      ...input,
      terminateControl: async () => undefined,
    }),
  ).rejects.toThrow("desktop_control_shutdown_incomplete");
  expect(spawnControl).not.toHaveBeenCalled();
});

it("does not spawn after stop aborts an outstanding Control replacement", async () => {
  const current = { control: child(), worker: child() };
  const abort = new AbortController();
  const spawnControl = vi.fn(() => child());
  let finish!: () => void;
  const pending = replaceDesktopControlRuntime({
    current,
    environment,
    signal: abort.signal,
    spawnControl,
    trackChild: vi.fn(),
    waitForReady: vi.fn(async () => undefined),
    terminateControl: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  const assertion = expect(pending).rejects.toThrow();
  abort.abort();
  Object.assign(current.control, { exitCode: 0 });
  finish();
  await assertion;
  expect(spawnControl).not.toHaveBeenCalled();
});

it("keeps the current real Node Worker while replacing Control and tracks the new child before readiness", async () => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-control-replacement-")),
  );
  const entry = join(directory, "child.mjs");
  writeFileSync(
    entry,
    "process.stdin.resume();process.stdout.write('ready\\n');",
  );
  const children: ChildProcess[] = [];
  const start = () => {
    const spawned = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(spawned);
    return spawned;
  };
  const control = start(),
    worker = start();
  try {
    await Promise.all([
      once(control.stdout!, "data"),
      once(worker.stdout!, "data"),
    ]);
    const tracked: ChildProcess[] = [];
    const replacement = await replaceDesktopControlRuntime({
      current: { control, worker },
      environment,
      signal: new AbortController().signal,
      terminateControl: terminateRuntimeChild,
      spawnControl: start,
      trackChild: (spawned) => tracked.push(spawned),
      waitForReady: async ([spawned, retained]) => {
        expect(tracked).toContain(spawned);
        expect(retained).toBe(worker);
        expect(worker.exitCode).toBeNull();
        await once(spawned!.stdout!, "data");
      },
    });
    expect(replacement.worker.pid).toBe(worker.pid);
    expect(replacement.control.pid).not.toBe(control.pid);
    expect(control.signalCode).toBe("SIGTERM");
    process.kill(worker.pid!, 0);
  } finally {
    await Promise.all(children.map((owned) => terminateRuntimeChild(owned)));
    rmSync(directory, { recursive: true, force: true });
  }
});
