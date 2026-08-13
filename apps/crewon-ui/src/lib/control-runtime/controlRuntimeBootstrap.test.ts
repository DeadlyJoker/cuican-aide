import { describe, expect, it, vi } from "vitest";

import { loadControlApiClient } from "./controlRuntimeBootstrap";

const SESSION = "s".repeat(32);
const CSRF = "c".repeat(32);

describe("Control runtime bootstrap", () => {
  it("uses a memory-only desktop session for JSON and SSE requests", async () => {
    const client = await loadControlApiClient({
      surface: "desktop",
      readDesktopSession: async () => ({
        baseUrl: "http://127.0.0.1:3210",
        csrfToken: CSRF,
        origin: "http://tauri.localhost",
        sessionToken: SESSION,
      }),
    });

    expect(client).not.toBeNull();
  });

  it("accepts only a same-origin Web BFF session", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ baseUrl: "/control-api", csrfToken: CSRF }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const client = await loadControlApiClient({
      fetch,
      pageOrigin: "https://crewon.example",
      surface: "web",
    });

    expect(client).not.toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://crewon.example/control-api/session"),
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
  });

  it.each([
    {
      name: "desktop non-loopback backend",
      input: {
        baseUrl: "https://remote.example",
        csrfToken: CSRF,
        origin: "http://tauri.localhost",
        sessionToken: SESSION,
      },
    },
    {
      name: "desktop extra secret field",
      input: {
        baseUrl: "http://127.0.0.1:3210",
        csrfToken: CSRF,
        origin: "http://tauri.localhost",
        sessionToken: SESSION,
        providerSecret: "must-not-enter-renderer",
      },
    },
    {
      name: "short session token",
      input: {
        baseUrl: "http://127.0.0.1:3210",
        csrfToken: CSRF,
        origin: "http://tauri.localhost",
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

  it("does not fall back when the packaged Control runtime is unavailable", async () => {
    await expect(
      loadControlApiClient({
        surface: "desktop",
        readDesktopSession: async () => {
          throw new Error("control_runtime_unavailable");
        },
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
      surface: "web",
    });

    expect(client).toBeNull();
  });
});
