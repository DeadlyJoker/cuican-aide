// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAgentPlatformSession,
  getAgentPlatformAccessSession,
  storeAgentPlatformSession,
} from "../agent-platform/agentPlatformClient";
import { loadControlApiClient } from "./controlRuntimeBootstrap";

const ORIGIN = "https://crewon.example";
const CSRF = "c".repeat(32);
const DESKTOP_SESSION = "s".repeat(32);
const WEB_SESSION = { baseUrl: "/control-api", csrfToken: CSRF };

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

function outcome<T>(pending: Promise<T>) {
  return pending.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
}

function delayedBody() {
  const body = deferred<unknown>();
  const entered = deferred<void>();
  let read = false;
  let canceled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (read) return;
          read = true;
          entered.resolve();
          const value = await body.promise;
          if (canceled) return;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
          controller.close();
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    {
      headers: { "content-type": "application/json" },
    },
  );
  return { response, body, entered };
}

function replaceSession(replacement: "account B" | "logout") {
  if (replacement === "account B")
    storeAgentPlatformSession("access-b", "refresh-b");
  else clearAgentPlatformSession();
}

describe("Control bootstrap account lifetime", () => {
  it("delivers the original verified Web result after the presentation deadline without another exchange", async () => {
    vi.useFakeTimers();
    const gate = deferred<Response>();
    const late = vi.fn();
    const fetch = vi.fn(() => gate.promise);
    const pending = loadControlApiClient({
      surface: "web",
      pageOrigin: ORIGIN,
      readWebAccessToken: async () => "access-a",
      fetch,
      onLateClient: late,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeNull();
    expect(late).not.toHaveBeenCalled();
    gate.resolve(Response.json(WEB_SESSION));
    await vi.advanceTimersByTimeAsync(0);
    expect(late).toHaveBeenCalledTimes(1);
    expect(late.mock.calls[0][0].requestOrigin).toBe(ORIGIN);
    expect(fetch).toHaveBeenCalledOnce();
  });
  for (const replacement of ["account B", "logout"] as const) {
    it(`does not deliver a late connection after ${replacement}`, async () => {
      vi.useFakeTimers();
      const gate = deferred<Response>();
      const late = vi.fn();
      const pending = loadControlApiClient({
        surface: "web",
        pageOrigin: ORIGIN,
        readWebAccessToken: async () => "access-a",
        fetch: () => gate.promise,
        onLateClient: late,
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toBeNull();
      replaceSession(replacement);
      gate.resolve(Response.json(WEB_SESSION));
      await vi.advanceTimersByTimeAsync(0);
      expect(late).not.toHaveBeenCalled();
    });
  }
  beforeEach(() => {
    vi.stubEnv("VITE_CREWON_UNIFIED_SSO_ENABLED", "false");
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("sessionStorage", memoryStorage());
    clearAgentPlatformSession();
    storeAgentPlatformSession("access-a", "refresh-a");
  });

  afterEach(() => {
    vi.useRealTimers();
    clearAgentPlatformSession();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  for (const replacement of ["account B", "logout"] as const) {
    it(`a late actual credential lookup cannot publish a Web client after ${replacement}`, async () => {
      const entered = deferred<void>();
      const delivery = deferred<void>();
      const fetchMock = vi.fn<typeof fetch>();
      const pending = loadControlApiClient({
        surface: "web",
        pageOrigin: ORIGIN,
        fetch: fetchMock,
        readWebAccessSession: async () => {
          const actual = await getAgentPlatformAccessSession();
          entered.resolve();
          await delivery.promise;
          return actual;
        },
      });
      await entered.promise;
      replaceSession(replacement);
      delivery.resolve();
      await expect(pending).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it(`a late Web session body cannot publish account A's client after ${replacement}`, async () => {
      const delayed = delayedBody();
      let signal: AbortSignal | null | undefined;
      const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
        signal = init?.signal;
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer access-a",
        );
        return delayed.response;
      });
      const pending = loadControlApiClient({
        surface: "web",
        pageOrigin: ORIGIN,
        fetch: fetchMock,
      });
      await delayed.entered.promise;
      replaceSession(replacement);
      expect(signal?.aborted).toBe(true);
      delayed.body.resolve(WEB_SESSION);
      await expect(pending).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  }

  it("an already published Web client cannot send HTTP after an account switch, while B's new client works", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/control-api/session")
        ? Response.json(WEB_SESSION)
        : Response.json({ data: [], nextCursor: null }),
    );
    const clientA = await loadControlApiClient({
      surface: "web",
      pageOrigin: ORIGIN,
      fetch: fetchMock,
    });
    expect(clientA).not.toBeNull();
    storeAgentPlatformSession("access-b", "refresh-b");
    await expect(clientA!.listThreads()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();

    const clientB = await loadControlApiClient({
      surface: "web",
      pageOrigin: ORIGIN,
      fetch: fetchMock,
    });
    expect(clientB).not.toBeNull();
    await expect(clientB!.listThreads()).resolves.toEqual({
      data: [],
      nextCursor: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer access-b");
  });

  it("an in-flight Web client request receives account withdrawal without accepting a late response", async () => {
    const headers = deferred<Response>();
    const entered = deferred<void>();
    let signal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/control-api/session"))
        return Response.json(WEB_SESSION);
      signal = init?.signal;
      entered.resolve();
      return headers.promise;
    });
    const client = await loadControlApiClient({
      surface: "web",
      pageOrigin: ORIGIN,
      fetch: fetchMock,
    });
    expect(client).not.toBeNull();
    const pending = client!.listThreads();
    const rejection = outcome(pending);
    let finished = false;
    void pending.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    await entered.promise;
    clearAgentPlatformSession();
    expect(signal?.aborted).toBe(true);
    expect(finished).toBe(false);
    headers.resolve(Response.json({ data: [], nextCursor: null }));
    expect(await rejection).toMatchObject({ status: "rejected" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a published Web client's delayed thread body cannot return account A's data after switching to B", async () => {
    const delayed = delayedBody();
    let signal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/control-api/session"))
        return Response.json(WEB_SESSION);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer access-a",
      );
      signal = init?.signal;
      return delayed.response;
    });
    const client = await loadControlApiClient({
      surface: "web",
      pageOrigin: ORIGIN,
      fetch: fetchMock,
    });
    expect(client).not.toBeNull();
    const pending = outcome(client!.listThreads());
    await delayed.entered.promise;
    storeAgentPlatformSession("access-b", "refresh-b");
    expect(signal?.aborted).toBe(true);
    delayed.body.resolve({ data: [], nextCursor: null });
    expect(await pending).toMatchObject({ status: "rejected" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("enterprise account switches do not revoke the independent Desktop session", async () => {
    const delivery = deferred<unknown>();
    const desktopFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [], nextCursor: null }),
    );
    const pending = loadControlApiClient({
      surface: "desktop",
      desktopFetch,
      readDesktopSession: () => delivery.promise,
    });
    storeAgentPlatformSession("access-b", "refresh-b");
    delivery.resolve({
      baseUrl: "http://127.0.0.1:3210",
      csrfToken: CSRF,
      origin: "http://crewon.localhost",
      sessionToken: DESKTOP_SESSION,
    });
    const desktop = await pending;
    expect(desktop).not.toBeNull();
    await expect(desktop!.listThreads()).resolves.toEqual({
      data: [],
      nextCursor: null,
    });
    clearAgentPlatformSession();
    await expect(desktop!.listThreads()).resolves.toEqual({
      data: [],
      nextCursor: null,
    });
    expect(desktopFetch).toHaveBeenCalledTimes(2);
    expect(
      new Headers(desktopFetch.mock.calls[1]?.[1]?.headers).get(
        "authorization",
      ),
    ).toBe(`Bearer ${DESKTOP_SESSION}`);
    expect(desktopFetch.mock.calls[1]?.[1]?.signal?.aborted).not.toBe(true);
  });
});
