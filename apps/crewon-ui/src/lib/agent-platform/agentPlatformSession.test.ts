import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginWeComLogin,
  completeWeComLogin,
  readWeComLoginConfig,
  registerAgentPlatform,
  setAgentPlatformPassword,
} from "./agentPlatformSession";
import { storeAgentPlatformSession } from "./agentPlatformClient";

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

describe("agent-platform WeCom session", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the disabled reason and navigates through the backend authorize endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          enabled: false,
          provider: "wecom",
          label: "企业微信",
          reason: "missing config",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await readWeComLoginConfig()).toEqual({
      enabled: false,
      provider: "wecom",
      label: "企业微信",
      reason: "missing config",
    });
    expect(await beginWeComLogin()).toBe(
      "/agent-platform-api/api/v1/auth/wecom/authorize",
    );
  });

  it("exchanges a one-time callback ticket without placing tokens in the URL", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 7,
            username: "wecom_user",
            email: "user@example.com",
            role: "user",
            linked_providers: ["wecom"],
            password_login_enabled: false,
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeWeComLogin("single-use-ticket"),
    ).resolves.toMatchObject({
      id: 7,
      linked_providers: ["wecom"],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/agent-platform-api/api/v1/auth/wecom/exchange",
      expect.objectContaining({
        body: JSON.stringify({ ticket: "single-use-ticket" }),
        method: "POST",
      }),
    );
  });

  it("sets the initial password through the authenticated account API", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    storeAgentPlatformSession("local-token");
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await setAgentPlatformPassword("CrewON123");

    expect(fetchMock).toHaveBeenCalledWith(
      "/agent-platform-api/api/v1/auth/set-password",
      expect.objectContaining({
        body: JSON.stringify({ new_password: "CrewON123" }),
        method: "POST",
      }),
    );
  });

  it("surfaces registration field validation messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              detail: [
                { msg: "Value error, 密码必须包含大写字母" },
                { msg: "Value error, 密码必须包含数字" },
              ],
            }),
            { status: 422 },
          ),
      ),
    );

    await expect(
      registerAgentPlatform({
        username: "weak-user",
        email: "weak-user@example.com",
        password: "lowercaseonly",
      }),
    ).rejects.toThrow(
      "Value error, 密码必须包含大写字母；Value error, 密码必须包含数字",
    );
  });
});
