import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginWeComLogin,
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

  it("reads the disabled reason and starts the configured authorize URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            enabled: false,
            provider: "wecom",
            label: "企业微信",
            reason: "missing config",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            auth_url: "https://login.work.weixin.qq.com/wwlogin/sso/login?state=signed",
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
    expect(await beginWeComLogin()).toContain("login.work.weixin.qq.com");
  });

  it("sets the initial password through the authenticated account API", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    storeAgentPlatformSession("local-token");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
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
