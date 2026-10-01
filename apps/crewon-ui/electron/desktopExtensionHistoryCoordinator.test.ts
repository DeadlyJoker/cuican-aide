import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopCurrentRuntimeChildren } from "./desktopControlRuntime.ts";
import type { DesktopExtensionHistoricalHostPeer } from "./desktopExtensionHistoricalHosts.ts";

// Historical validation is covered by the manager's real HTTP/protocol tests. This
// port supplies peer notifications while Control/Worker lifecycle below uses Node.
const manager = vi.hoisted(() => ({
  onPeersChanged: null as
    | null
    | ((peers: readonly DesktopExtensionHistoricalHostPeer[]) => Promise<void>),
  pending: Promise.resolve() as Promise<void>,
  peers: [
    {
      origin: "http://127.0.0.1:2222",
      token: "b".repeat(64),
      deadlineMs: 1000,
    },
  ],
}));

vi.mock("./desktopExtensionHistoricalHosts.ts", () => ({
  DesktopExtensionHistoricalHosts: class {
    ownedChildren: ChildProcess[] = [];
    readonly dependencies: {
      onPeersChanged: (
        peers: readonly DesktopExtensionHistoricalHostPeer[],
      ) => Promise<void>;
      onDiagnostic: (code: string) => void;
    };
    constructor(dependencies: typeof this.dependencies) {
      this.dependencies = dependencies;
      manager.onPeersChanged = dependencies.onPeersChanged;
    }
    start(): Promise<void> {
      manager.pending = this.dependencies
        .onPeersChanged(manager.peers)
        .catch(() => {
          this.dependencies.onDiagnostic(
            "desktop_extension_historical_peer_update_failed",
          );
        });
      return manager.pending;
    }
    async stop(): Promise<void> {}
  },
}));

vi.mock("./desktopExtensionHistoricalInputs.ts", () => ({
  prepareDesktopExtensionHistoricalWorker: vi.fn(),
}));

import { DesktopExtensionHistoryCoordinator } from "./desktopExtensionHistoryCoordinator.ts";

const baselineEnvironment = {
  CREWON_EXTENSIONS_ENABLED: "1",
  CREWON_EXTENSION_HOST_ORIGIN: "http://127.0.0.1:1111",
  CREWON_EXTENSION_HOST_TOKEN: "a".repeat(64),
  CREWON_AGENT_VERSION_ID: "current-default",
  CREWON_MODEL_ID: "current-model",
  CREWON_MODEL_API_KEY: "private-current-model-key",
};

function terminal(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (terminal(child)) return;
  await new Promise<void>((resolve, reject) => {
    const onClose = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      child.kill("SIGKILL");
      reject(new Error("fixture_child_shutdown_timeout"));
    }, 2000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("close", onClose);
    };
    child.once("close", onClose);
    child.kill("SIGTERM");
  });
}

type FixtureOptions = {
  failFirstTermination?: boolean;
  failReplacementTermination?: boolean;
  baselineUnready?: boolean;
  beforeReplacementTermination?: () => Promise<void>;
};

async function fixture(options: FixtureOptions = {}) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-history-control-")),
  );
  const entry = join(directory, "control.mjs");
  writeFileSync(
    entry,
    `import { createServer } from "node:http";
const ready = process.env.FIXTURE_CONTROL_UNREADY !== "1";
const server = createServer((_request, response) => {
  response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
  response.end("{}");
});
server.listen(0, "127.0.0.1", () => {
  console.log("ORIGIN http://127.0.0.1:" + server.address().port);
});
process.stdin.resume();
`,
  );
  const all: ChildProcess[] = [];
  const controls: {
    child: ChildProcess;
    environment: NodeJS.ProcessEnv;
    origin: Promise<string>;
  }[] = [];
  const startControl = (
    environment: NodeJS.ProcessEnv,
    unready: boolean,
  ): ChildProcess => {
    const child = spawn(process.execPath, [entry], {
      env: {
        ...environment,
        FIXTURE_CONTROL_UNREADY: unready ? "1" : "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    all.push(child);
    child.stderr?.resume();
    const origin = new Promise<string>((resolve, reject) => {
      let buffer = "";
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onError = () => {
        cleanup();
        reject(new Error("fixture_control_spawn_failed"));
      };
      const onExit = () => {
        cleanup();
        reject(new Error("fixture_control_exited_before_origin"));
      };
      const onData = (bytes: Buffer) => {
        buffer += bytes.toString("utf8");
        const match = /^ORIGIN (http:\/\/127\.0\.0\.1:\d+)\n/u.exec(buffer);
        if (match !== null) {
          cleanup();
          resolve(match[1]!);
          child.stdout?.resume();
        }
      };
      const timer = setTimeout(onError, 3000);
      child.stdout?.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    void origin.catch(() => undefined);
    controls.push({ child, environment: { ...environment }, origin });
    return child;
  };
  const original = startControl(baselineEnvironment, false);
  const worker = spawn(process.execPath, ["-e", "process.stdin.resume();"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  all.push(worker);
  worker.stdout?.resume();
  worker.stderr?.resume();
  await controls[0]!.origin;
  const abort = new AbortController();
  const roots = new Set([original, worker]);
  const registered: DesktopCurrentRuntimeChildren[] = [];
  const finished: DesktopCurrentRuntimeChildren[] = [];
  const diagnostics: string[] = [];
  let current: DesktopCurrentRuntimeChildren = { control: original, worker };
  let ready = true;
  let epoch = true;
  const begin = vi.fn(() => {
    ready = false;
  });
  const restore = vi.fn(() => {
    ready = !terminal(current.control) && !terminal(worker);
  });
  const coordinator = new DesktopExtensionHistoryCoordinator({
    dataRoot: directory,
    currentCapsuleId: null,
    controlEnvironment: baselineEnvironment,
    signal: abort.signal,
    resolveProvider: () => ({
      availability: "unavailable",
      reason: "provider_not_configured",
    }),
    spawnHistoricalWorker: () => {
      throw new Error("unexpected_historical_spawn");
    },
    spawnControl: (environment) =>
      startControl(
        environment,
        environment.CREWON_EXTENSION_HISTORICAL_HOSTS_JSON !== undefined ||
          options.baselineUnready === true,
      ),
    terminate: async (child) => {
      if (child === original && options.failFirstTermination)
        throw new Error(baselineEnvironment.CREWON_MODEL_API_KEY);
      if (child === controls[1]?.child) {
        await options.beforeReplacementTermination?.();
        if (options.failReplacementTermination)
          throw new Error(baselineEnvironment.CREWON_MODEL_API_KEY);
      }
      await terminateChild(child);
    },
    trackChild: (child) => roots.add(child),
    releaseChild: (child) => {
      expect(terminal(child)).toBe(true);
      roots.delete(child);
    },
    isCurrent: () => epoch,
    currentChildren: () => current,
    beginControlReplacement: begin,
    registerControlReplacement: (children) => {
      expect(roots.has(children.control)).toBe(true);
      expect(children.worker).toBe(worker);
      current = children;
      registered.push(children);
    },
    restoreUnchangedControl: restore,
    finishControlReplacement: (children) => {
      current = children;
      ready = true;
      finished.push(children);
    },
    waitForControlReady: async ([control, currentWorker], signal) => {
      expect(currentWorker).toBe(worker);
      expect(roots.has(control!)).toBe(true);
      expect(current.control).toBe(control);
      const record = controls.find((item) => item.child === control)!;
      const origin = await record.origin;
      signal.throwIfAborted();
      const response = await fetch(`${origin}/api/v1/health/ready`, { signal });
      await response.body?.cancel();
      if (!response.ok) throw new Error("fixture_control_readiness_failed");
    },
    diagnostic: (code) => diagnostics.push(code),
  });
  const result = {
    coordinator,
    original,
    worker,
    controls,
    roots,
    registered,
    finished,
    diagnostics,
    abort,
    begin,
    restore,
    current: () => current,
    ready: () => ready,
    stale: () => {
      epoch = false;
    },
    cleanup: async () => {
      abort.abort();
      await coordinator.stop();
      await Promise.allSettled(all.map(terminateChild));
      rmSync(directory, { recursive: true, force: true });
    },
  };
  fixtures.push(result);
  return result;
}

const fixtures: { cleanup: () => Promise<void> }[] = [];
beforeEach(() => {
  manager.onPeersChanged = null;
  manager.pending = Promise.resolve();
});
afterEach(async () => {
  for (const item of fixtures.splice(0)) await item.cleanup();
});

it("recovers an alive unready replacement with baseline Control and the same real Worker", async () => {
  const item = await fixture();
  const workerPid = item.worker.pid;
  item.coordinator.start();
  await manager.pending;
  expect(item.controls).toHaveLength(3);
  expect(
    item.controls[1]!.environment.CREWON_EXTENSION_HISTORICAL_HOSTS_JSON,
  ).toBeDefined();
  expect(item.controls[2]!.environment).toEqual(baselineEnvironment);
  expect(item.current()).toEqual({
    control: item.controls[2]!.child,
    worker: item.worker,
  });
  expect(item.worker.pid).toBe(workerPid);
  expect(terminal(item.worker)).toBe(false);
  expect(terminal(item.original)).toBe(true);
  expect(terminal(item.controls[1]!.child)).toBe(true);
  expect(item.roots).toEqual(new Set([item.worker, item.controls[2]!.child]));
  expect(item.ready()).toBe(true);
  expect(item.finished).toEqual([item.current()]);
  expect(item.begin).toHaveBeenCalledTimes(2);
  expect(item.restore).not.toHaveBeenCalled();
  expect(item.diagnostics).toEqual([
    "desktop_extension_historical_control_update_failed",
    "desktop_extension_historical_peer_update_failed",
  ]);
  // Resetting the baseline identity makes withdrawal a no-op, and a repeated
  // failed notification does not repeatedly tear down healthy baseline Control.
  await manager.onPeersChanged!(manager.peers);
  expect(item.controls).toHaveLength(3);
  await manager.onPeersChanged!([]);
  expect(item.controls).toHaveLength(3);
  await expect(manager.onPeersChanged!(manager.peers)).rejects.toThrow();
  expect(item.controls).toHaveLength(5);
  expect(item.ready()).toBe(true);
  expect(item.diagnostics.join()).not.toContain(
    baselineEnvironment.CREWON_MODEL_API_KEY,
  );
});

it("retains a living replacement when termination fails and never starts a duplicate baseline", async () => {
  const item = await fixture({ failReplacementTermination: true });
  item.coordinator.start();
  await manager.pending;
  expect(item.controls).toHaveLength(2);
  expect(terminal(item.controls[1]!.child)).toBe(false);
  expect(item.roots).toEqual(new Set([item.worker, item.controls[1]!.child]));
  expect(item.registered.at(-1)).toEqual(item.current());
  expect(item.finished).toEqual([]);
  expect(item.ready()).toBe(false);
  expect(item.diagnostics).toContain(
    "desktop_extension_historical_control_recovery_failed",
  );
  expect(item.diagnostics.join()).not.toContain(
    baselineEnvironment.CREWON_MODEL_API_KEY,
  );
});

it("preserves the existing healthy Control when its initial termination fails", async () => {
  const item = await fixture({ failFirstTermination: true });
  item.coordinator.start();
  await manager.pending;
  expect(item.controls).toHaveLength(1);
  expect(item.roots).toEqual(new Set([item.original, item.worker]));
  expect(item.ready()).toBe(true);
  expect(item.restore).toHaveBeenCalledOnce();
  expect(item.finished).toEqual([]);
  expect(item.diagnostics).not.toContain(
    "desktop_extension_historical_control_recovery_failed",
  );
});

it("retains and supervises a failed baseline without claiming that current Control is ready", async () => {
  const item = await fixture({ baselineUnready: true });
  item.coordinator.start();
  await manager.pending;
  expect(item.controls).toHaveLength(3);
  expect(item.current().control).toBe(item.controls[2]!.child);
  expect(item.current().worker).toBe(item.worker);
  expect(terminal(item.controls[2]!.child)).toBe(false);
  expect(item.roots).toEqual(new Set([item.worker, item.controls[2]!.child]));
  expect(item.registered.at(-1)).toEqual(item.current());
  expect(item.finished).toEqual([]);
  expect(item.ready()).toBe(false);
  expect(item.diagnostics).toContain(
    "desktop_extension_historical_control_recovery_failed",
  );
});

it.each(["abort", "stale"] as const)(
  "does not spawn baseline Control or write readiness when %s occurs during fallback termination",
  async (mode) => {
    let entered!: () => void;
    const terminating = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const item = await fixture({
      beforeReplacementTermination: async () => {
        entered();
        await barrier;
      },
    });
    item.coordinator.start();
    try {
      await terminating;
      if (mode === "abort") item.abort.abort();
      else item.stale();
    } finally {
      release();
    }
    await manager.pending;
    expect(item.controls).toHaveLength(2);
    expect(item.finished).toEqual([]);
    expect(item.ready()).toBe(false);
    expect(item.diagnostics).not.toContain(
      "desktop_extension_historical_control_recovery_failed",
    );
    expect(item.diagnostics).not.toContain(
      "desktop_extension_historical_control_update_failed",
    );
  },
);
