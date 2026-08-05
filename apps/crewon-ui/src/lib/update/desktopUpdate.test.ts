import { describe, expect, it, vi } from "vitest";

import {
  checkForUpdate,
  createProgressTracker,
  installUpdate,
  type UpdateHandle,
  type UpdateState,
  type UpdaterPort,
} from "./desktopUpdate";

/*
 * The update flow is the one path that can brick a user's install, so its states
 * are covered rather than eyeballed. The cases that matter are the ones that are
 * easy to get wrong: a manifest without a content length, an unreachable
 * endpoint, and the web build where there is nothing to update at all.
 */

function recorder() {
  const states: UpdateState[] = [];
  return { states, emit: (state: UpdateState) => void states.push(state) };
}

function handleStub(overrides: Partial<UpdateHandle> = {}): UpdateHandle {
  return {
    version: "0.2.0",
    notes: "faster",
    downloadAndInstall: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("checkForUpdate", () => {
  it("reports unsupported without a port instead of throwing", async () => {
    const { states, emit } = recorder();

    await expect(checkForUpdate(null, emit)).resolves.toBeNull();
    expect(states).toEqual([{ phase: "unsupported" }]);
  });

  it("reports current when the manifest offers nothing newer", async () => {
    const { states, emit } = recorder();
    const port: UpdaterPort = { check: async () => null, relaunch: async () => {} };

    await expect(checkForUpdate(port, emit)).resolves.toBeNull();
    expect(states).toEqual([{ phase: "checking" }, { phase: "current" }]);
  });

  it("surfaces the offered version when one is available", async () => {
    const { states, emit } = recorder();
    const handle = handleStub();
    const port: UpdaterPort = { check: async () => handle, relaunch: async () => {} };

    await expect(checkForUpdate(port, emit)).resolves.toBe(handle);
    expect(states).toEqual([
      { phase: "checking" },
      { phase: "available", version: "0.2.0", notes: "faster" },
    ]);
  });

  it("reports an unreachable endpoint as failed rather than crashing", async () => {
    const { states, emit } = recorder();
    const port: UpdaterPort = {
      check: async () => {
        throw new Error("network unreachable");
      },
      relaunch: async () => {},
    };

    await expect(checkForUpdate(port, emit)).resolves.toBeNull();
    expect(states).toEqual([
      { phase: "checking" },
      { phase: "failed", error: "network unreachable" },
    ]);
  });
});

describe("createProgressTracker", () => {
  it("reports a fraction of the announced content length", () => {
    const track = createProgressTracker();

    expect(track({ event: "Started", data: { contentLength: 400 } })).toBe(0);
    expect(track({ event: "Progress", data: { chunkLength: 100 } })).toBe(0.25);
    expect(track({ event: "Progress", data: { chunkLength: 300 } })).toBe(1);
  });

  it("reports no fraction when the manifest omits the content length", () => {
    // Dividing by zero would put the bar at Infinity; indeterminate is correct.
    const track = createProgressTracker();

    expect(track({ event: "Started", data: {} })).toBeUndefined();
    expect(track({ event: "Progress", data: { chunkLength: 100 } })).toBeUndefined();
    expect(track({ event: "Finished" })).toBe(1);
  });

  it("clamps at one when more bytes arrive than announced", () => {
    const track = createProgressTracker();

    track({ event: "Started", data: { contentLength: 100 } });

    expect(track({ event: "Progress", data: { chunkLength: 250 } })).toBe(1);
  });
});

describe("installUpdate", () => {
  it("relaunches after a successful install", async () => {
    const { states, emit } = recorder();
    const relaunch = vi.fn(async () => {});
    const handle = handleStub({
      downloadAndInstall: async (onProgress) => {
        onProgress({ event: "Started", data: { contentLength: 200 } });
        onProgress({ event: "Progress", data: { chunkLength: 200 } });
        onProgress({ event: "Finished" });
      },
    });

    await installUpdate({ check: async () => handle, relaunch }, handle, emit);

    expect(states.map((state) => state.phase)).toEqual([
      "downloading",
      "downloading",
      "downloading",
      "downloading",
      "ready",
    ]);
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("does not relaunch when the download fails", async () => {
    const { states, emit } = recorder();
    const relaunch = vi.fn(async () => {});
    const handle = handleStub({
      downloadAndInstall: async () => {
        throw new Error("signature mismatch");
      },
    });

    await installUpdate({ check: async () => handle, relaunch }, handle, emit);

    expect(relaunch).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({
      phase: "failed",
      error: "signature mismatch",
    });
  });
});
