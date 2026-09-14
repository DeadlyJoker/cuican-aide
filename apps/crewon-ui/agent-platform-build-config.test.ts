import { describe, expect, it } from "vitest";
import { agentPlatformBuildConfig } from "./agent-platform-build-config";

describe("account endpoint build configuration", () => {
  it("packages the hosted account service from a clean checkout without local env files", () => {
    expect(agentPlatformBuildConfig("desktop", {})).toEqual({
      proxyTarget: "https://pim.aicuican.com",
      runtimeBaseUrl: "https://pim.aicuican.com",
      accountBaseUrl: "https://pim.aicuican.com",
    });
  });

  it.each(["development", "production", "test"])(
    "preserves the local proxy target for %s web builds",
    (mode) => {
      expect(agentPlatformBuildConfig(mode, {}).proxyTarget).toBe(
        "http://127.0.0.1:8000",
      );
    },
  );

  it("uses the configured proxy backend for desktop account and runtime requests", () => {
    expect(
      agentPlatformBuildConfig("desktop", {
        VITE_AGENT_PLATFORM_BASE_URL: "/agent-platform-api",
        CREWON_AGENT_PLATFORM_TARGET: "https://accounts.example.com/",
      }).runtimeBaseUrl,
    ).toBe("https://accounts.example.com");
  });

  it.each(["VITE_AGENT_PLATFORM_BASE_URL", "VITE_AGENT_PLATFORM_API_BASE_URL"])(
    "preserves an absolute %s deployment override",
    (key) => {
      expect(
        agentPlatformBuildConfig("desktop", {
          [key]: "https://accounts.example.com/platform/",
        }).runtimeBaseUrl,
      ).toBe("https://accounts.example.com/platform");
    },
  );

  it("allows an explicit local deployment and runtime override", () => {
    expect(
      agentPlatformBuildConfig("desktop", {
        VITE_AGENT_PLATFORM_RUNTIME_BASE_URL: "http://127.0.0.1:8001/",
      }).runtimeBaseUrl,
    ).toBe("http://127.0.0.1:8001");
  });

  it.each([
    "/agent-platform-api",
    "file:///api",
    "http://accounts.example.com",
    "https://user:secret@accounts.example.com",
    "https://accounts.example.com?token=secret",
    "https://accounts.example.com#fragment",
  ])(
    "rejects an unusable or credential-bearing packaged endpoint %s",
    (value) => {
      expect(() =>
        agentPlatformBuildConfig("desktop", {
          VITE_AGENT_PLATFORM_RUNTIME_BASE_URL: value,
        }),
      ).toThrow();
    },
  );
});
