// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "./agentPlatformSessionEvents";
import { useInstalledPluginTaskContext } from "../plugins/useInstalledPluginTaskContext";
import {
  taskContextDeferred,
  taskContextFixture,
  taskContextJson,
  taskContextModule,
  taskContextReceipt,
  taskContextThread,
} from "../plugins/installedPluginTaskContext.test-support";
import type { InstalledPluginTaskContextState } from "../plugins/useInstalledPluginTaskContext.types";
import {
  attachPimLaunchToken,
  clearPimLaunchToken,
  getPimLaunchToken,
  isPimLaunchSession,
  setPimLaunchToken,
} from "./pimLaunchBridge";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("pimLaunchBridge", () => {
  beforeEach(() => {
    clearPimLaunchToken();
  });

  describe("getPimLaunchToken", () => {
    it("returns null when no token is present", () => {
      expect(getPimLaunchToken()).toBeNull();
    });

    it("returns a token previously set via setPimLaunchToken", () => {
      setPimLaunchToken("test-launch-token");
      expect(getPimLaunchToken()).toBe("test-launch-token");
    });

    it("strips Bearer prefix", () => {
      setPimLaunchToken("Bearer my-token");
      expect(getPimLaunchToken()).toBe("my-token");
    });

    it("normalizes surrounding whitespace", () => {
      setPimLaunchToken("  token-with-spaces  ");
      expect(getPimLaunchToken()).toBe("token-with-spaces");
    });

    it("returns null for empty tokens", () => {
      setPimLaunchToken("");
      expect(getPimLaunchToken()).toBeNull();
    });

    it("returns the token as-is when it is only a Bearer prefix (no content)", () => {
      setPimLaunchToken("Bearer ");
      expect(getPimLaunchToken()).toBe("Bearer");
    });
  });

  describe("isPimLaunchSession", () => {
    it("returns false when no token is present", () => {
      expect(isPimLaunchSession()).toBe(false);
    });

    it("returns true when a token is present", () => {
      setPimLaunchToken("active-token");
      expect(isPimLaunchSession()).toBe(true);
    });
  });

  describe("setPimLaunchToken", () => {
    it("overwrites the previous token", () => {
      setPimLaunchToken("first-token");
      setPimLaunchToken("second-token");
      expect(getPimLaunchToken()).toBe("second-token");
    });
  });

  describe("clearPimLaunchToken", () => {
    it("removes the current token", () => {
      setPimLaunchToken("token-to-clear");
      clearPimLaunchToken();
      expect(getPimLaunchToken()).toBeNull();
    });
  });

  describe("attachPimLaunchToken", () => {
    it("adds the X-PIM-Launch-Token header when a token is present", () => {
      setPimLaunchToken("attach-token");
      const headers = new Headers();
      attachPimLaunchToken(headers);
      expect(headers.get("X-PIM-Launch-Token")).toBe("attach-token");
    });

    it("does not overwrite an existing X-PIM-Launch-Token header", () => {
      setPimLaunchToken("bridge-token");
      const headers = new Headers({ "X-PIM-Launch-Token": "existing-token" });
      attachPimLaunchToken(headers);
      expect(headers.get("X-PIM-Launch-Token")).toBe("existing-token");
    });

    it("does nothing when no token is present", () => {
      const headers = new Headers();
      attachPimLaunchToken(headers);
      expect(headers.has("X-PIM-Launch-Token")).toBe(false);
    });

    it("returns the same Headers instance for chaining", () => {
      const headers = new Headers();
      expect(attachPimLaunchToken(headers)).toBe(headers);
    });
  });
});

describe("captured PIM session replacement and withdrawal", () => {
  const originalUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const cleanups: (() => void)[] = [];

  async function capture(search = "?pim_launch_token=captured-fixture-token") {
    window.history.replaceState({}, "", `/pim-entry${search}#view-command`);
    vi.resetModules();
    return import("./pimLaunchBridge");
  }

  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, "", "/pim-entry");
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sessionStorage.clear();
    window.history.replaceState({}, "", originalUrl);
    vi.resetModules();
  });

  it("clears the URL-captured token in the same module instance and never attaches it again", async () => {
    const bridge = await capture(
      "?keep=1&pim_launch_token=captured-fixture-token&launch_token=alias-fixture-token",
    );
    expect(bridge.getPimLaunchToken()).toBe("captured-fixture-token");
    expect(window.location.search).toBe("?keep=1");
    expect(window.location.hash).toBe("#view-command");
    expect(sessionStorage.getItem("pim_launch_token")).toBe(
      "captured-fixture-token",
    );

    bridge.clearPimLaunchToken();

    expect(bridge.getPimLaunchToken()).toBeNull();
    expect(bridge.isPimLaunchSession()).toBe(false);
    expect(
      bridge.attachPimLaunchToken(new Headers()).has("X-PIM-Launch-Token"),
    ).toBe(false);
    expect(sessionStorage.getItem("pim_launch_token")).toBeNull();
  });

  it("replaces a URL-captured token with the refreshed token in memory, persistence and request headers", async () => {
    const bridge = await capture();
    bridge.setPimLaunchToken("  Bearer refreshed-fixture-token  ");
    expect(bridge.getPimLaunchToken()).toBe("refreshed-fixture-token");
    expect(sessionStorage.getItem("pim_launch_token")).toBe(
      "refreshed-fixture-token",
    );
    expect(
      bridge.attachPimLaunchToken(new Headers()).get("X-PIM-Launch-Token"),
    ).toBe("refreshed-fixture-token");
  });

  it("captures the legacy URL alias and preserves the original URL cleanup", async () => {
    const bridge = await capture(
      "?launch_token=Bearer%20alias-fixture-token&keep=2",
    );
    expect(bridge.getPimLaunchToken()).toBe("alias-fixture-token");
    expect(window.location.search).toBe("?keep=2");
    expect(window.location.hash).toBe("#view-command");
  });

  it("restores an existing stored session once, then honors replacement and clear", async () => {
    sessionStorage.setItem("pim_launch_token", "Bearer stored-fixture-token");
    const bridge = await capture("?keep=3");
    expect(bridge.getPimLaunchToken()).toBe("stored-fixture-token");
    bridge.setPimLaunchToken("new-fixture-token");
    expect(bridge.getPimLaunchToken()).toBe("new-fixture-token");
    bridge.clearPimLaunchToken();
    expect(bridge.getPimLaunchToken()).toBeNull();
  });

  it.each(["missing", "access", "read", "write", "remove"] as const)(
    "keeps replacement and withdrawal effective when sessionStorage is %s, including later restoration",
    async (mode) => {
      const persisted = sessionStorage;
      persisted.setItem("pim_launch_token", "older-persisted-fixture-token");
      const unavailable = () => {
        throw new DOMException("Named storage failure", "SecurityError");
      };
      const storage = {
        get length() {
          return mode === "access" ? unavailable() : persisted.length;
        },
        getItem(key: string) {
          return mode === "read" ? unavailable() : persisted.getItem(key);
        },
        setItem(key: string, value: string) {
          if (mode === "write") unavailable();
          persisted.setItem(key, value);
        },
        removeItem(key: string) {
          if (mode === "remove") unavailable();
          persisted.removeItem(key);
        },
      };
      vi.stubGlobal("sessionStorage", mode === "missing" ? undefined : storage);
      const bridge = await capture();
      expect(bridge.getPimLaunchToken()).toBe("captured-fixture-token");
      expect(window.location.search).toBe("");
      bridge.setPimLaunchToken("replacement-fixture-token");
      expect(
        bridge.attachPimLaunchToken(new Headers()).get("X-PIM-Launch-Token"),
      ).toBe("replacement-fixture-token");
      bridge.clearPimLaunchToken();
      expect(bridge.getPimLaunchToken()).toBeNull();
      vi.unstubAllGlobals();
      persisted.setItem("pim_launch_token", "older-persisted-fixture-token");
      expect(bridge.getPimLaunchToken()).toBeNull();
      expect(
        bridge.attachPimLaunchToken(new Headers()).has("X-PIM-Launch-Token"),
      ).toBe(false);
      bridge.setPimLaunchToken("final-fixture-token");
      expect(bridge.getPimLaunchToken()).toBe("final-fixture-token");
      expect(persisted.getItem("pim_launch_token")).toBe("final-fixture-token");
    },
  );

  it("handles getItem failure without a URL and can establish a new in-memory session", async () => {
    vi.spyOn(sessionStorage, "getItem").mockImplementation(() => {
      throw new DOMException("Named read failure", "SecurityError");
    });
    const bridge = await capture("?keep=4");
    expect(bridge.getPimLaunchToken()).toBeNull();
    bridge.setPimLaunchToken("new-fixture-token");
    expect(bridge.getPimLaunchToken()).toBe("new-fixture-token");
    bridge.clearPimLaunchToken();
    expect(bridge.getPimLaunchToken()).toBeNull();
  });

  it("replaces and clears the in-memory session without a browser or storage", async () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("sessionStorage", undefined);
    vi.resetModules();
    const bridge = await import("./pimLaunchBridge");
    expect(bridge.getPimLaunchToken()).toBeNull();
    bridge.setPimLaunchToken("memory-fixture-token");
    bridge.setPimLaunchToken("replacement-fixture-token");
    expect(
      bridge.attachPimLaunchToken(new Headers()).get("X-PIM-Launch-Token"),
    ).toBe("replacement-fixture-token");
    bridge.clearPimLaunchToken();
    vi.unstubAllGlobals();
    expect(bridge.getPimLaunchToken()).toBeNull();
    expect(
      bridge.attachPimLaunchToken(new Headers()).has("X-PIM-Launch-Token"),
    ).toBe(false);
  });

  it("keeps the captured token when URL cleanup itself is unavailable", async () => {
    window.history.replaceState(
      {},
      "",
      "/pim-entry?pim_launch_token=captured-fixture-token",
    );
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new DOMException("Named history failure", "SecurityError");
    });
    vi.resetModules();
    const bridge = await import("./pimLaunchBridge");
    expect(bridge.getPimLaunchToken()).toBe("captured-fixture-token");
    bridge.clearPimLaunchToken();
    expect(bridge.getPimLaunchToken()).toBeNull();
  });

  it("notifies public event consumers only for real changes and never on initial URL capture", async () => {
    const events: Event[] = [];
    const observe = (event: Event) => events.push(event);
    window.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, observe);
    cleanups.push(() =>
      window.removeEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, observe),
    );
    const bridge = await capture();
    expect(events).toHaveLength(0);
    bridge.setPimLaunchToken("Bearer captured-fixture-token");
    bridge.setPimLaunchToken("");
    expect(events).toHaveLength(0);
    bridge.setPimLaunchToken("next-fixture-token");
    expect(events).toHaveLength(1);
    bridge.clearPimLaunchToken();
    expect(events).toHaveLength(2);
    bridge.clearPimLaunchToken();
    expect(events).toHaveLength(2);
    expect(
      events.every(
        (event) =>
          event.type === AGENT_PLATFORM_SESSION_CHANGED_EVENT &&
          !("detail" in event),
      ),
    ).toBe(true);
  });

  it("synchronously withdraws internal owners before the public event and can suppress only that public event", async () => {
    const bridge = await capture();
    const controller = new AbortController();
    const observed: (string | null)[] = [];
    const order: string[] = [];
    let publicEvents = 0;
    cleanups.push(
      bridge.onPimLaunchTokenChanged(() => {
        observed.push(bridge.getPimLaunchToken());
        order.push("internal");
        controller.abort();
      }),
    );
    const observe = () => {
      publicEvents++;
      order.push("public");
      expect(controller.signal.aborted).toBe(true);
    };
    window.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, observe);
    cleanups.push(() =>
      window.removeEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, observe),
    );
    bridge.clearPimLaunchToken({ notifySessionChanged: false });
    expect(controller.signal.aborted).toBe(true);
    expect(observed).toEqual([null]);
    expect(publicEvents).toBe(0);
    bridge.setPimLaunchToken("next-fixture-token");
    expect(observed).toEqual([null, "next-fixture-token"]);
    expect(publicEvents).toBe(1);
    expect(order).toEqual(["internal", "internal", "public"]);
    bridge.setPimLaunchToken("next-fixture-token");
    expect(observed).toHaveLength(2);
  });

  it("removes an internal token-change subscription without reactivating the old token", async () => {
    const bridge = await capture();
    const listener = vi.fn();
    const unsubscribe = bridge.onPimLaunchTokenChanged(listener);
    bridge.setPimLaunchToken("next-fixture-token");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    bridge.clearPimLaunchToken();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bridge.getPimLaunchToken()).toBeNull();
  });

  it.each(["clear", "replace"] as const)(
    "invalidates the actual installed task-context consumer and aborts its outstanding read on PIM %s",
    async (change) => {
      const bridge = await capture();
      const fixture = taskContextFixture();
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      let state: InstalledPluginTaskContextState | null = null;
      const input = {
        ports: fixture.ports,
        module: taskContextModule(),
        active: true,
        selectedThreadId: "thread-1",
        runIds: [],
      };
      function Probe() {
        state = useInstalledPluginTaskContext(input);
        return createElement("output", null, JSON.stringify(state.data));
      }
      const snapshot = () => {
        if (state === null) throw new Error("task_context_not_rendered");
        return state;
      };
      const late = taskContextDeferred<Response>();
      try {
        await act(async () => root.render(createElement(Probe)));
        await act(async () => {
          await vi.waitFor(() => expect(snapshot().phase).toBe("ready"));
        });
        expect(snapshot().thread?.revision).toBe(17);
        const readyRequestCount = fixture.requests.length;
        fixture.setHandler((request) =>
          request.path === "/api/v1/threads/thread-1"
            ? late.promise
            : undefined,
        );
        await act(async () => snapshot().refresh());
        await vi.waitFor(() =>
          expect(fixture.requests).toHaveLength(readyRequestCount + 1),
        );
        const refreshRequests = fixture.requests.slice(readyRequestCount);
        expect(refreshRequests).toHaveLength(1);
        const pending = refreshRequests[0]!;
        expect(pending.path).toBe("/api/v1/threads/thread-1");
        expect(pending.method).toBe("GET");
        expect(pending.signal).toBeInstanceOf(AbortSignal);
        expect(pending.signal?.aborted).toBe(false);
        await act(async () => {
          if (change === "clear") bridge.clearPimLaunchToken();
          else bridge.setPimLaunchToken("different-session-fixture-token");
          expect(pending.signal?.aborted).toBe(true);
        });
        expect(snapshot().phase).toBe("idle");
        expect(snapshot().thread).toBeNull();
        expect(snapshot().tasks).toHaveLength(0);
        await act(async () => {
          late.resolve(
            taskContextJson({
              thread: taskContextThread("thread-1", 999),
              eventSequence: 999,
            }),
          );
          fixture.emit(taskContextReceipt());
        });
        expect(snapshot().phase).toBe("idle");
        expect(snapshot().thread).toBeNull();
        expect(fixture.adopt).not.toHaveBeenCalled();
        expect(
          fixture.requests.every((request) => request.method === "GET"),
        ).toBe(true);
      } finally {
        late.resolve(
          taskContextJson({ thread: taskContextThread(), eventSequence: 17 }),
        );
        await act(async () => root.unmount());
        container.remove();
      }
    },
  );
});
