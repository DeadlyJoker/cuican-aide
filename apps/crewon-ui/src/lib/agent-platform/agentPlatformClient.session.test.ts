// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "./agentPlatformSessionEvents";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function jwt(subject: string): string {
  return `header.${btoa(JSON.stringify({ sub: subject, exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
}
function storage(values: Map<string, string>): Storage {
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}
function delayedBody(body: unknown) {
  const reading = deferred<void>();
  const release = deferred<void>();
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          reading.resolve();
          await release.promise;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { "Content-Type": "application/json" } },
  );
  return { response, reading, release };
}

describe("Agent Platform request account fences", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_CREWON_UNIFIED_SSO_ENABLED", "false");
    vi.stubGlobal("localStorage", storage(new Map()));
    vi.stubGlobal("sessionStorage", storage(new Map()));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  for (const outcome of ["401", "network rejection"] as const) {
    it(`an old A request's late ${outcome} cannot clear B or retry using B's credential`, async () => {
      const client = await import("./agentPlatformClient");
      const tokenA = jwt("A");
      const tokenB = jwt("B");
      client.storeAgentPlatformSession(tokenA, "refresh-A");
      const entered = deferred<AbortSignal>();
      const response = deferred<Response>();
      const fetchMock = vi.fn(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          entered.resolve(init!.signal as AbortSignal);
          return response.promise;
        },
      );
      vi.stubGlobal("fetch", fetchMock);
      const pending = client.agentPlatformAuthorizedFetch("/api/v1/mcp/tools");
      const signalA = await entered.promise;
      client.storeAgentPlatformSession(tokenB, "refresh-B");
      expect(signalA.aborted).toBe(true);
      if (outcome === "401")
        response.resolve(new Response(null, { status: 401 }));
      else response.reject(new Error("late A network failure"));
      await expect(pending).rejects.toThrow("agent_platform_session_changed");
      await expect(client.getAgentPlatformAccessToken()).resolves.toBe(tokenB);
      expect(
        localStorage.getItem(client.AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY),
      ).toBe("refresh-B");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization"),
      ).toBe(`Bearer ${tokenA}`);
    });
  }

  it("a request cannot retry after B arrives while A's refresh body is still being read", async () => {
    const client = await import("./agentPlatformClient");
    client.storeAgentPlatformSession(jwt("A"), "refresh-A");
    const body = delayedBody({
      access_token: jwt("fresh-A"),
      refresh_token: "rotated-A",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(body.response);
    vi.stubGlobal("fetch", fetchMock);
    const pending = client.agentPlatformAuthorizedFetch("/api/v1/mcp/tools");
    await body.reading.promise;
    const tokenB = jwt("B");
    client.storeAgentPlatformSession(tokenB, "refresh-B");
    body.release.resolve();
    await expect(pending).rejects.toThrow("agent_platform_session_changed");
    await expect(client.getAgentPlatformAccessToken()).resolves.toBe(tokenB);
    expect(
      localStorage.getItem(client.AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY),
    ).toBe("refresh-B");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("normal 401 refresh retry returns the actual final request's current snapshot", async () => {
    const client = await import("./agentPlatformClient");
    client.storeAgentPlatformSession(jwt("A"), "refresh-A");
    const previous = client.captureAgentPlatformSession();
    const freshA = jwt("fresh-A");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ access_token: freshA }))
      .mockResolvedValueOnce(Response.json({ id: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const final = await client.agentPlatformAuthorizedSessionFetch({
      path: "/api/v1/auth/me",
    });
    expect(previous.signal.aborted).toBe(true);
    expect(final.session.signal.aborted).toBe(false);
    expect(() =>
      client.assertAgentPlatformSessionCurrent(final.session),
    ).not.toThrow();
    await expect(final.response.json()).resolves.toEqual({ id: 1 });
    expect(
      new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("Authorization"),
    ).toBe(`Bearer ${freshA}`);
    expect(
      localStorage.getItem(client.AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY),
    ).toBe("refresh-A");
  });

  it("the generic authenticated Workflow request rejects a late A body after switching to B", async () => {
    const client = await import("./agentPlatformClient");
    client.storeAgentPlatformSession(jwt("A"));
    const body = delayedBody({ id: 17, name: "A workflow" });
    const fetchMock = vi.fn().mockResolvedValue(body.response);
    vi.stubGlobal("fetch", fetchMock);
    const pending = client.createAgentPlatformWorkflow({
      description: "A workflow",
      edges: [],
      lead: "A",
      name: "A workflow",
      nodes: [],
    });
    await body.reading.promise;
    const tokenB = jwt("B");
    client.storeAgentPlatformSession(tokenB);
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(
      true,
    );
    body.release.resolve();
    await expect(pending).rejects.toThrow("agent_platform_session_changed");
    await expect(client.getAgentPlatformAccessToken()).resolves.toBe(tokenB);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("atomic explicit publication rejects a reentrant login that supersedes it", async () => {
    const client = await import("./agentPlatformClient");
    const tokenB = jwt("B");
    const previous = client.captureAgentPlatformSession();
    const switchAccount = () => {
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        switchAccount,
      );
      client.storeAgentPlatformSession(tokenB);
    };
    window.addEventListener(
      AGENT_PLATFORM_SESSION_CHANGED_EVENT,
      switchAccount,
    );
    try {
      expect(() =>
        client.publishAgentPlatformSession({
          session: previous,
          accessToken: jwt("A"),
        }),
      ).toThrow("agent_platform_session_changed");
      await expect(client.getAgentPlatformAccessToken()).resolves.toBe(tokenB);
    } finally {
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        switchAccount,
      );
    }
  });

  it("atomic interactive withdrawal cannot capture a reentrant B account as its own scope", async () => {
    const client = await import("./agentPlatformClient");
    client.storeAgentPlatformSession(jwt("A"));
    const tokenB = jwt("B");
    const switchAccount = () => {
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        switchAccount,
      );
      client.storeAgentPlatformSession(tokenB);
    };
    window.addEventListener(
      AGENT_PLATFORM_SESSION_CHANGED_EVENT,
      switchAccount,
    );
    try {
      expect(() => client.beginAgentPlatformInteractiveSession()).toThrow(
        "agent_platform_session_changed",
      );
      await expect(client.getAgentPlatformAccessToken()).resolves.toBe(tokenB);
    } finally {
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        switchAccount,
      );
    }
  });

  for (const failure of ["getter", "remove"] as const) {
    it(`logout clears the same PIM instance and notifies despite a localStorage ${failure} failure`, async () => {
      const client = await import("./agentPlatformClient");
      const pim = await import("./pimLaunchBridge");
      const values = new Map<string, string>();
      const persisted = storage(values);
      vi.stubGlobal("localStorage", persisted);
      client.storeAgentPlatformSession("opaque-A", "refresh-A");
      pim.setPimLaunchToken("pim-A");
      const previous = client.captureAgentPlatformSession();
      await expect(client.getAgentPlatformAccessToken()).resolves.toBe("pim-A");
      if (failure === "getter") {
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          get: () => {
            throw new Error("storage getter denied");
          },
        });
      } else {
        vi.stubGlobal("localStorage", {
          ...persisted,
          removeItem: () => {
            throw new Error("storage removal denied");
          },
        });
      }
      const notifications: Array<string | null> = [];
      const notified = () => {
        notifications.push(pim.getPimLaunchToken());
      };
      window.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, notified);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      try {
        expect(() => client.clearAgentPlatformSession()).not.toThrow();
        expect(previous.signal.aborted).toBe(true);
        expect(pim.getPimLaunchToken()).toBeNull();
        expect(notifications).toEqual([null]);
        await expect(client.getAgentPlatformAccessToken()).resolves.toBeNull();
        expect(values.get(client.AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBe(
          "opaque-A",
        );
        expect(fetchMock).not.toHaveBeenCalled();
        expect(() =>
          client.storeAgentPlatformSession("opaque-B"),
        ).not.toThrow();
        await expect(client.getAgentPlatformAccessToken()).resolves.toBe(
          "opaque-B",
        );
      } finally {
        window.removeEventListener(
          AGENT_PLATFORM_SESSION_CHANGED_EVENT,
          notified,
        );
      }
    });
  }

  it("a directory aggregate rejects late A results after B arrives while its directory reads are pending", async () => {
    const client = await import("./agentPlatformClient");
    const tokenA = jwt("A");
    const tokenB = jwt("B");
    client.storeAgentPlatformSession(tokenA);
    const directoriesEntered = deferred<void>();
    const directories = deferred<Response>();
    let directoryCalls = 0;
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = String(url);
        if (path.endsWith("/api/v1/health"))
          return Response.json({ status: "ok" });
        if (path.endsWith("/api/v1/auth/me"))
          return Response.json({ id: 1, username: "A", role: "user" });
        signals.push(init!.signal as AbortSignal);
        if (++directoryCalls === 7) directoriesEntered.resolve();
        const original = await directories.promise;
        return original.clone();
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = client.readAgentPlatformSnapshot();
    await directoriesEntered.promise;
    client.storeAgentPlatformSession(tokenB);
    expect(signals).toHaveLength(7);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    directories.resolve(
      Response.json({
        items: [{ id: 1, user_id: 1, name: "A resource" }],
        resources: {},
      }),
    );
    await expect(pending).rejects.toThrow("agent_platform_session_changed");
    await expect(client.getAgentPlatformAccessToken()).resolves.toBe(tokenB);
    expect(fetchMock).toHaveBeenCalledTimes(9);
    for (const [url, init] of fetchMock.mock.calls) {
      if (!String(url).endsWith("/api/v1/health")) {
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Bearer ${tokenA}`,
        );
      }
    }
  });

  it("a B microtask after the me body completes cannot send the A aggregate's directory requests as B", async () => {
    const client = await import("./agentPlatformClient");
    client.storeAgentPlatformSession(jwt("A"));
    const tokenB = jwt("B");
    const me = Response.json({ id: 1, username: "A", role: "user" });
    const readMe = me.json.bind(me);
    vi.spyOn(me, "json").mockImplementation(async () => {
      const value = await readMe();
      queueMicrotask(() => client.storeAgentPlatformSession(tokenB));
      return value;
    });
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/api/v1/health"))
        return Response.json({ status: "ok" });
      if (String(url).endsWith("/api/v1/auth/me")) return me;
      throw new Error(
        "the retired A aggregate must not dispatch directory reads",
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(client.readAgentPlatformSnapshot()).rejects.toThrow(
      "agent_platform_session_changed",
    );
    await expect(client.getAgentPlatformAccessToken()).resolves.toBe(tokenB);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/agent-platform-api/api/v1/health",
      "/agent-platform-api/api/v1/auth/me",
    ]);
  });
});
