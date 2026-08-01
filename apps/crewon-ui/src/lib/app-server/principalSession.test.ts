import { describe, expect, it, vi } from "vitest";

import {
  PRINCIPAL_SESSION_SUBPROTOCOL,
  PrincipalSessionConnectionError,
  createPrincipalSessionProtocols,
  principalSessionExchangeUrl,
  principalSessionFrontendEnabled,
} from "./principalSession";

describe("principal session frontend gate", () => {
  it("is default-off and accepts only exact boolean strings", () => {
    expect(principalSessionFrontendEnabled(undefined)).toBe(false);
    expect(principalSessionFrontendEnabled("false")).toBe(false);
    expect(principalSessionFrontendEnabled("true")).toBe(true);
    for (const value of ["TRUE", " true", "1", ""]) {
      expect(() => principalSessionFrontendEnabled(value)).toThrow(
        PrincipalSessionConnectionError,
      );
    }
  });

  it("maps proxied and direct websocket URLs to the bounded exchange route", () => {
    expect(
      principalSessionExchangeUrl("ws://127.0.0.1:5175/app-server"),
    ).toBe("http://127.0.0.1:5175/app-server/principal-session/exchange");
    expect(principalSessionExchangeUrl("wss://example.test/crewon")).toBe(
      "https://example.test/crewon/principal-session/exchange",
    );
  });
});

describe("principal session bootstrap and exchange", () => {
  it("keeps tokens in memory and returns the browser websocket subprotocols", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ token: "bootstrap.jwt", expiresAt: 1_900_000_000 }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ token: "session.jwt", expiresAt: 1_900_000_300 }),
          { status: 200 },
        ),
      );

    await expect(
      createPrincipalSessionProtocols("ws://127.0.0.1:5175/app-server", {
        fetchImpl,
        readAccessToken: async () => "access.jwt",
      }),
    ).resolves.toEqual([PRINCIPAL_SESSION_SUBPROTOCOL, "session.jwt"]);

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/agent-platform-api/identity/v1/principal-bootstrap:issue",
      expect.objectContaining({
        method: "POST",
        body: undefined,
        cache: "no-store",
        credentials: "same-origin",
        headers: expect.objectContaining({ Authorization: "Bearer access.jwt" }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:5175/app-server/principal-session/exchange",
      expect.objectContaining({
        body: JSON.stringify({ bootstrapToken: "bootstrap.jwt" }),
        cache: "no-store",
        credentials: "same-origin",
      }),
    );
  });

  it("fails closed without echoing malformed or unavailable session material", async () => {
    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ token: "raw", expiresAt: 1, extra: true }), {
          status: 200,
        }),
      );
    await expect(
      createPrincipalSessionProtocols("ws://app-server", {
        fetchImpl: malformed,
        readAccessToken: async () => "access.jwt",
      }),
    ).rejects.toEqual(new PrincipalSessionConnectionError());
    await expect(
      createPrincipalSessionProtocols("ws://app-server", {
        fetchImpl: vi.fn<typeof fetch>(),
        readAccessToken: async () => null,
      }),
    ).rejects.toEqual(new PrincipalSessionConnectionError());
  });
});
