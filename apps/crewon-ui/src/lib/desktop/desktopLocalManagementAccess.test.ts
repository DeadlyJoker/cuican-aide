import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isDesktopLocalManagementAccess,
  subscribeDesktopLocalManagementAccess,
} from "./desktopLocalManagementAccess";

const dto = (generation = 0) => ({
  schemaVersion: "crewon.desktop-local-management-access.v1",
  generation,
});
async function flush() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}
function native(read: () => Promise<unknown>) {
  let listener: (() => void) | null = null;
  const unsubscribe = vi.fn(() => {
    listener = null;
  });
  const runtime = {
    localManagementAccess: vi.fn(read),
    onLocalManagementAccessChanged: vi.fn((next: () => void) => {
      listener = next;
      return unsubscribe;
    }),
  };
  vi.stubGlobal("window", { crewonDesktop: { version: 1, runtime } });
  return { changed: () => listener?.(), runtime, unsubscribe };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Native local management access", () => {
  it("requires both actual additive bridge methods, never URL or a renderer flag", async () => {
    for (const bridge of [
      undefined,
      { version: 1, runtime: {} },
      {
        version: 1,
        runtime: { localManagementAccess: vi.fn(async () => dto()) },
      },
    ]) {
      vi.stubGlobal("window", {
        crewonDesktop: bridge,
        location: { search: "?surface=desktop&localManagement=true" },
        localManagementAccess: true,
      });
      const listener = vi.fn();
      const stop = subscribeDesktopLocalManagementAccess(listener);
      await flush();
      expect(listener.mock.calls).toEqual([[null]]);
      stop();
    }
    expect(isDesktopLocalManagementAccess(dto())).toBe(false);
  });

  it("brands only Native replies and keeps copied DTOs unauthorized", async () => {
    const host = native(async function (this: unknown) {
      expect(this).toBe(host.runtime);
      return dto(4);
    });
    const listener = vi.fn();
    const stop = subscribeDesktopLocalManagementAccess(listener);
    await flush();
    const access = listener.mock.calls.at(-1)![0];
    expect(access.generation).toBe(4);
    expect(Object.isFrozen(access)).toBe(true);
    expect(isDesktopLocalManagementAccess(access)).toBe(true);
    expect(isDesktopLocalManagementAccess({ ...access })).toBe(false);
    stop();
    expect(isDesktopLocalManagementAccess(access)).toBe(false);
    expect(host.unsubscribe).toHaveBeenCalledOnce();
  });

  it("withdraws before a changed-session query and ignores a late old-generation reply", async () => {
    let resolveLate!: (value: unknown) => void;
    let next: unknown = dto(1);
    const host = native(async () => next);
    const listener = vi.fn();
    const stop = subscribeDesktopLocalManagementAccess(listener);
    await flush();
    const first = listener.mock.calls.at(-1)![0];
    next = new Promise((resolve) => {
      resolveLate = resolve;
    });
    host.changed();
    expect(isDesktopLocalManagementAccess(first)).toBe(false);
    expect(listener.mock.calls.at(-1)).toEqual([null]);
    await flush();
    next = dto(3);
    host.changed();
    await flush();
    const fresh = listener.mock.calls.at(-1)![0];
    expect(fresh.generation).toBe(3);
    resolveLate(dto(2));
    await flush();
    expect(listener.mock.calls.at(-1)![0]).toBe(fresh);
    stop();
  });

  it("fails closed on null, errors, wrong shapes and accessors without running getters", async () => {
    const getter = vi.fn(() => 0);
    const accessor = Object.defineProperty(
      { schemaVersion: dto().schemaVersion },
      "generation",
      {
        enumerable: true,
        get: getter,
      },
    );
    for (const value of [
      null,
      true,
      { ...dto(), actor: "guest" },
      dto(-1),
      dto(0.5),
      { ...dto(), schemaVersion: "future" },
      accessor,
    ]) {
      native(async () => value);
      const listener = vi.fn();
      const stop = subscribeDesktopLocalManagementAccess(listener);
      await flush();
      expect(listener.mock.calls).toEqual([[null]]);
      stop();
    }
    native(async () => {
      throw new Error("session closed");
    });
    const listener = vi.fn();
    const stop = subscribeDesktopLocalManagementAccess(listener);
    await flush();
    expect(listener.mock.calls).toEqual([[null]]);
    expect(getter).not.toHaveBeenCalled();
    stop();
  });

  it("bounds stalled IPC and cannot publish access after disposal", async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const host = native(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const listener = vi.fn();
    const stop = subscribeDesktopLocalManagementAccess(listener);
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listener.mock.calls).toEqual([[null]]);
    stop();
    resolve(dto(5));
    await flush();
    host.changed();
    expect(listener.mock.calls).toEqual([[null]]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
