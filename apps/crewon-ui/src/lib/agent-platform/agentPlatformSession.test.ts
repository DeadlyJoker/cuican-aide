import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginWeComLogin,
  completeWeComLogin,
  logoutAgentPlatform,
  readAgentPlatformCurrentUser,
  readWeComLoginConfig,
  registerAgentPlatform,
  setAgentPlatformPassword,
} from "./agentPlatformSession";
import {
  AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY,
  AGENT_PLATFORM_TOKEN_STORAGE_KEY,
  clearAgentPlatformSession,
  storeAgentPlatformSession,
} from "./agentPlatformClient";

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
    clearAgentPlatformSession();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses the OIDC BFF and keeps mediated tokens out of localStorage", async () => {
    vi.stubEnv("VITE_CREWON_UNIFIED_SSO_ENABLED", "true");
    const storage = memoryStorage();
    storage.setItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY, "legacy-access");
    storage.setItem(
      AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY,
      "legacy-refresh",
    );
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", {
      location: { pathname: "/workspace", search: "?thread=7" },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "mediated-access",
          expires_in: 600,
          user: {
            id: 7,
            username: "sso-user",
            display_name: "企微用户",
            wecom_display_name: "企微用户",
            email: "sso@example.com",
            role: "user",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    expect(await readWeComLoginConfig()).toMatchObject({
      enabled: true,
      label: "企业统一登录",
    });
    expect(await beginWeComLogin()).toBe(
      "/agent-platform-api/sso/client/crewon/start?return_to=%2Fworkspace%3Fthread%3D7",
    );
    await expect(readAgentPlatformCurrentUser()).resolves.toMatchObject({
      id: 7,
      username: "sso-user",
      display_name: "企微用户",
      wecom_display_name: "企微用户",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/agent-platform-api/sso/client/crewon/token",
      expect.objectContaining({
        credentials: "same-origin",
        method: "POST",
      }),
    );
    expect(storage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY)).toBeNull();
    expect(
      storage.getItem(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY),
    ).toBeNull();
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

  it("uses global logout so the next login requires a fresh enterprise sign-in", async () => {
    vi.stubEnv("VITE_CREWON_UNIFIED_SSO_ENABLED", "true");
    vi.stubGlobal("localStorage", memoryStorage());
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await logoutAgentPlatform();

    expect(fetchMock).toHaveBeenCalledWith(
      "/agent-platform-api/sso/client/crewon/global-logout",
      expect.objectContaining({ credentials: "same-origin", method: "POST" }),
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
