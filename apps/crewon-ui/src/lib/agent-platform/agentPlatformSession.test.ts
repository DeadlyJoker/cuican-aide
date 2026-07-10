import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginWeComLogin,
  readWeComLoginConfig,
} from "./agentPlatformSession";

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
});
