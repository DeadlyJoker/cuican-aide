import { afterEach, describe, expect, it, vi } from "vitest";

import { loadControlApiClient } from "./controlRuntimeBootstrap";

const SESSION = "s".repeat(32);
const CSRF = "c".repeat(32);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Control runtime bootstrap", () => {
  it("uses a memory-only desktop session with the native HTTP transport", async () => {
    const desktopFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = await loadControlApiClient({
      desktopFetch,
      surface: "desktop",
      readDesktopSession: async () => ({
        baseUrl: "http://127.0.0.1:3210",
        csrfToken: CSRF,
        origin: "http://crewon.localhost",
        sessionToken: SESSION,
      }),
    });

    expect(client).not.toBeNull();
    await client?.listThreads();
    expect(desktopFetch).toHaveBeenCalledOnce();
  });

  it("uses the current desktop IPC session under Electron dev", async () => {
    vi.stubGlobal("window", {
      crewonDesktop: { version: 1 },
      location: { search: "" },
    });
    const fetch = vi.fn();
    const readDesktopSession = vi.fn(async () => ({
      baseUrl: "http://127.0.0.1:3210",
      csrfToken: CSRF,
      origin: "http://crewon.localhost",
      sessionToken: SESSION,
    }));

    const client = await loadControlApiClient({
      fetch,
      pageOrigin: "http://127.0.0.1:5175",
      readDesktopSession,
    });

    expect(client).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(readDesktopSession).toHaveBeenCalledOnce();
  });

  it("does not leave the desktop app blank when IPC bootstrap stalls", async () => {
    vi.useFakeTimers();
    const clientPromise = loadControlApiClient({
      surface: "desktop",
      readDesktopSession: () => new Promise(() => {}),
    });

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(clientPromise).resolves.toBeNull();
  });

  it("accepts only a same-origin Web BFF session", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ baseUrl: "/control-api", csrfToken: CSRF }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const client = await loadControlApiClient({
      fetch: fetch as typeof globalThis.fetch,
      pageOrigin: "https://crewon.example",
      readWebAccessToken: async () => "p".repeat(32),
      surface: "web",
    });

    expect(client).not.toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://crewon.example/control-api/session"),
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        headers: expect.any(Headers),
      }),
    );
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe(`Bearer ${"p".repeat(32)}`);
  });

  it("does not expose a Web Control session without a PIM access token", async () => {
    const fetch = vi.fn();

    const client = await loadControlApiClient({
      fetch,
      pageOrigin: "https://crewon.example",
      readWebAccessToken: async () => null,
      surface: "web",
    });

    expect(client).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "desktop non-loopback backend",
      input: {
        baseUrl: "https://remote.example",
        csrfToken: CSRF,
        origin: "http://crewon.localhost",
        sessionToken: SESSION,
      },
    },
    {
      name: "desktop extra secret field",
      input: {
        baseUrl: "http://127.0.0.1:3210",
        csrfToken: CSRF,
        origin: "http://crewon.localhost",
        sessionToken: SESSION,
        providerSecret: "must-not-enter-renderer",
      },
    },
    {
      name: "short session token",
      input: {
        baseUrl: "http://127.0.0.1:3210",
        csrfToken: CSRF,
        origin: "http://crewon.localhost",
        sessionToken: "short",
      },
    },
  ])("fails closed for $name", async ({ input }) => {
    await expect(
      loadControlApiClient({
        surface: "desktop",
        readDesktopSession: async () => input,
      }),
    ).resolves.toBeNull();
  });

  it("rejects cross-origin Web Control endpoints", async () => {
    const client = await loadControlApiClient({
      fetch: async () =>
        new Response(
          JSON.stringify({
            baseUrl: "https://attacker.example/control-api",
            csrfToken: CSRF,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      pageOrigin: "https://crewon.example",
      readWebAccessToken: async () => "p".repeat(32),
      surface: "web",
    });

    expect(client).toBeNull();
  });
});
