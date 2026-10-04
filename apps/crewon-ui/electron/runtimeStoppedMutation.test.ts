import { afterEach, expect, it, vi } from "vitest";
import { desktopPluginManagementFixture } from "./desktopPluginManagementRuntime.test-support.ts";
import { RuntimeSupervisor } from "./runtimeSupervisor.ts";
import { runRuntimeStoppedMutation } from "./runtimeStoppedMutation.ts";

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function queuedSupervisor() {
  return new RuntimeSupervisor({
    dataDirectory: "/unused-stopped-mutation",
    paths: {
      control: "/unused/control",
      worker: "/unused/worker",
      release: "/unused/release",
      modelCatalog: "/unused/catalog",
      workspaceMcp: "/unused/mcp",
      source: false,
    },
    repositoryRoot: null,
    provider: () => null,
    providerModelCatalog: async () => null,
    workspaceRoot: () => null,
    agentPlatformApiKeyForOrigin: () => null,
  });
}

it("joins the physical stop even when the invalidation wrapper returns early", async () => {
  const stopped = deferred();
  const entered = deferred();
  const mutation = vi.fn(async () => "committed");
  const start = vi.fn(async () => {});
  const operation = runRuntimeStoppedMutation(
    {
      onStopInvalidation: async (stop) => {
        void stop();
        entered.resolve();
      },
      mutation,
    },
    { stop: () => stopped.promise, start, assertReady() {} },
  );
  try {
    await entered.promise;
    expect(mutation).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  } finally {
    stopped.resolve();
  }
  await expect(operation).resolves.toEqual({
    value: "committed",
    runtimeStatus: "ready",
  });
});

it("joins an actual pending stop after an invalidation wrapper throws", async () => {
  const stopped = deferred();
  const entered = deferred();
  const failure = new Error("named-invalidation-wrapper-failure");
  const mutation = vi.fn(async () => "unreachable");
  const start = vi.fn(async () => {});
  let finished = false;
  const operation = runRuntimeStoppedMutation(
    {
      onStopInvalidation: async (stop) => {
        void stop();
        entered.resolve();
        throw failure;
      },
      mutation,
    },
    { stop: () => stopped.promise, start, assertReady() {} },
  );
  const observed = operation.then(
    () => {
      finished = true;
    },
    (error: unknown) => {
      finished = true;
      expect(error).toBe(failure);
    },
  );
  try {
    await entered.promise;
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(mutation).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  } finally {
    stopped.resolve();
  }
  await observed;
});

it("rejects stop failure without performing a mutation or starting the runtime", async () => {
  const failure = new Error("named-physical-stop-failure");
  const mutation = vi.fn(async () => "unreachable");
  const start = vi.fn(async () => {});
  await expect(
    runRuntimeStoppedMutation(
      { mutation, onStopInvalidation: (stop) => stop() },
      {
        stop: async () => {
          throw failure;
        },
        start,
        assertReady() {},
      },
    ),
  ).rejects.toBe(failure);
  expect(mutation).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

it("keeps a committed value when the subsequent runtime start fails", async () => {
  let commits = 0;
  await expect(
    runRuntimeStoppedMutation(
      {
        onStopInvalidation: (stop) => stop(),
        mutation: async () => {
          commits++;
          return Object.freeze({ receipt: "named-committed-source" });
        },
      },
      {
        stop: async () => {},
        start: async () => {
          throw new Error("named-runtime-start-failure");
        },
        assertReady() {},
      },
    ),
  ).resolves.toEqual({
    value: { receipt: "named-committed-source" },
    runtimeStatus: "restartRequired",
  });
  expect(commits).toBe(1);
});

it("does not report ready when start returns without an available original session", async () => {
  await expect(
    runRuntimeStoppedMutation(
      {
        mutation: async () => "committed",
        onStopInvalidation: (stop) => stop(),
      },
      {
        stop: async () => {},
        start: async () => {},
        assertReady() {
          throw new Error("control_runtime_unavailable");
        },
      },
    ),
  ).resolves.toEqual({
    value: "committed",
    runtimeStatus: "restartRequired",
  });
});

it.each(["succeeds", "fails"] as const)(
  "restores after mutation failure when restoration %s and preserves the original error",
  async (restoration) => {
    const failure = new Error("named-approval-cas-conflict");
    const start = vi.fn(async () => {
      if (restoration === "fails") throw new Error("named-restore-failure");
    });
    await expect(
      runRuntimeStoppedMutation(
        {
          mutation: async () => {
            throw failure;
          },
          onStopInvalidation: (stop) => stop(),
        },
        { stop: async () => {}, start, assertReady() {} },
      ),
    ).rejects.toBe(failure);
    expect(start).toHaveBeenCalledTimes(1);
  },
);

it("requires the invalidation wrapper to invoke the actual stop exactly once", async () => {
  const stop = vi.fn(async () => {});
  const start = vi.fn(async () => {});
  const mutation = vi.fn(async () => "unreachable");
  await expect(
    runRuntimeStoppedMutation(
      { mutation, onStopInvalidation: async () => {} },
      { stop, start, assertReady() {} },
    ),
  ).rejects.toThrow("desktop_runtime_mutation_stop_not_called");
  await expect(
    runRuntimeStoppedMutation(
      {
        mutation,
        onStopInvalidation: async (physicalStop) => {
          await physicalStop();
          await physicalStop();
        },
      },
      { stop, start, assertReady() {} },
    ),
  ).rejects.toThrow("desktop_runtime_mutation_stop_already_called");
  expect(stop).toHaveBeenCalledTimes(1);
  expect(mutation).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

it("withdraws a saved stop callback after its invalidation wrapper has returned", async () => {
  const stop = vi.fn(async () => {});
  let savedStop: (() => Promise<void>) | undefined;
  await expect(
    runRuntimeStoppedMutation(
      {
        mutation: async () => "unreachable",
        onStopInvalidation: async (physicalStop) => {
          savedStop = physicalStop;
        },
      },
      { stop, start: async () => {}, assertReady() {} },
    ),
  ).rejects.toThrow("desktop_runtime_mutation_stop_not_called");
  expect(() => savedStop?.()).toThrow(
    "desktop_runtime_mutation_stop_scope_closed",
  );
  expect(stop).not.toHaveBeenCalled();
});

it("shares the original Supervisor restart queue and recovers its tail after a failed mutation", async () => {
  const owner = queuedSupervisor();
  const events: string[] = [];
  const firstStartEntered = deferred();
  const firstStartRelease = deferred();
  const mutationEntered = deferred();
  const mutationRelease = deferred();
  const failure = new Error("named-mutation-failure");
  let starts = 0;
  vi.spyOn(owner, "stop").mockImplementation(async () => {
    events.push("stop");
  });
  vi.spyOn(owner, "start").mockImplementation(async () => {
    starts++;
    events.push("start");
    if (starts === 1) {
      firstStartEntered.resolve();
      await firstStartRelease.promise;
    }
  });
  const previous = owner.restart();
  await firstStartEntered.promise;
  const operation = owner.mutateWhileStopped({
    onStopInvalidation: (stop) => stop(),
    mutation: async () => {
      events.push("mutation");
      mutationEntered.resolve();
      await mutationRelease.promise;
      throw failure;
    },
  });
  const observedFailure = expect(operation).rejects.toBe(failure);
  const following = owner.restart();
  try {
    expect(events).toEqual(["stop", "start"]);
    firstStartRelease.resolve();
    await mutationEntered.promise;
    expect(events).toEqual(["stop", "start", "stop", "mutation"]);
    expect(starts).toBe(1);
  } finally {
    firstStartRelease.resolve();
    mutationRelease.resolve();
  }
  await previous;
  await observedFailure;
  await following;
  expect(events).toEqual([
    "stop",
    "start",
    "stop",
    "mutation",
    "start",
    "stop",
    "start",
  ]);
});

it("physically stops the original Native child before mutation and blocks queued restarts until it completes", async () => {
  const f = desktopPluginManagementFixture({
    provider: "absent",
    approval: "present",
  });
  const firstStartEntered = deferred();
  const firstStartRelease = deferred();
  const mutationEntered = deferred();
  const mutationRelease = deferred();
  const pending: Promise<unknown>[] = [];
  let synchronousOwnStop = false;
  const invalidations: boolean[] = [];
  const remove = f.owner.onSessionInvalidated(() => {
    invalidations.push(synchronousOwnStop);
  });
  try {
    await f.owner.start();
    const start = f.owner.start.bind(f.owner);
    vi.spyOn(f.owner, "start").mockImplementationOnce(async () => {
      firstStartEntered.resolve();
      await firstStartRelease.promise;
      await start();
    });
    const previous = f.owner.restart();
    pending.push(previous);
    await firstStartEntered.promise;
    const operation = f.owner.mutateWhileStopped({
      onStopInvalidation: (stop) => {
        synchronousOwnStop = true;
        try {
          return stop();
        } finally {
          synchronousOwnStop = false;
        }
      },
      mutation: async () => {
        mutationEntered.resolve();
        const controls = f
          .records()
          .filter((record) => record.kind === "control");
        expect(controls).toHaveLength(2);
        for (const child of controls)
          expect(() => process.kill(child.pid, 0)).toThrow();
        expect(() => f.owner.session()).toThrow("control_runtime_unavailable");
        await mutationRelease.promise;
        return "named-source-committed";
      },
    });
    pending.push(operation);
    const following = f.owner.restart();
    pending.push(following);
    firstStartRelease.resolve();
    await mutationEntered.promise;
    expect(
      f.records().filter((record) => record.kind === "control"),
    ).toHaveLength(2);
    expect(invalidations).toEqual([false, true]);
    mutationRelease.resolve();
    await expect(operation).resolves.toEqual({
      value: "named-source-committed",
      runtimeStatus: "ready",
    });
    await previous;
    await following;
    expect(invalidations).toEqual([false, true, false]);
    const controls = f.records().filter((record) => record.kind === "control");
    expect(controls).toHaveLength(4);
    for (const child of controls.slice(0, -1))
      expect(() => process.kill(child.pid, 0)).toThrow();
    expect(() => f.owner.session()).not.toThrow();
  } finally {
    firstStartRelease.resolve();
    mutationRelease.resolve();
    await Promise.allSettled(pending);
    remove();
    const pids = f.records().map((record) => record.pid);
    await f.close();
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  }
}, 20_000);
