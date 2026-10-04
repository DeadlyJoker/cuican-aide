import { describe, expect, it } from "vitest";
import {
  desktopAccountOriginForBuild,
  parseDesktopTrustedAccountOrigin,
} from "./desktopAccountOrigin.ts";

describe("desktop account origin", () => {
  it("keeps the default transport limited to loopback", () => {
    expect(parseDesktopTrustedAccountOrigin(undefined)).toBeNull();
    expect(parseDesktopTrustedAccountOrigin(null)).toBeNull();
    expect(desktopAccountOriginForBuild({})).toBeNull();
  });

  it("accepts one canonical HTTPS origin including a deliberate port", () => {
    expect(parseDesktopTrustedAccountOrigin("https://pim.aicuican.com")).toBe(
      "https://pim.aicuican.com",
    );
    expect(
      parseDesktopTrustedAccountOrigin("https://platform.example:8443"),
    ).toBe("https://platform.example:8443");
  });

  it.each([
    "",
    "/agent-platform-api",
    "https:pim.aicuican.com",
    "http://pim.aicuican.com",
    "http://127.0.0.1:8000",
    "file:///tmp/account",
    "https://pim.aicuican.com/",
    "https://pim.aicuican.com/api",
    "https://pim.aicuican.com?",
    "https://pim.aicuican.com#",
    "https://user:password@pim.aicuican.com",
    "https://@pim.aicuican.com",
    " https://pim.aicuican.com",
    "https://pim.aicuican.com\n",
    "https://pim.aicuican.com:70000",
    `https://${"x".repeat(2_048)}.example`,
    42,
    {},
  ])("rejects invalid trusted origin %j", (value) => {
    expect(() => parseDesktopTrustedAccountOrigin(value)).toThrow(
      "desktop_http_account_origin_invalid",
    );
  });

  it("uses the same public proxy target as the packaged Renderer", () => {
    expect(
      desktopAccountOriginForBuild({
        proxyTarget: "https://pim.aicuican.com/",
      }),
    ).toBe("https://pim.aicuican.com");
  });

  it("takes the explicit runtime backend ahead of the proxy target", () => {
    expect(
      desktopAccountOriginForBuild({
        baseUrl: "/custom-proxy",
        runtimeBaseUrl: "https://platform.example/backend/",
        proxyTarget: "https://pim.aicuican.com",
      }),
    ).toBe("https://platform.example");
  });

  it("takes an absolute base override ahead of runtime and proxy targets", () => {
    expect(
      desktopAccountOriginForBuild({
        baseUrl: " https://platform.example/api/ ",
        apiBaseUrl: "https://alias.example",
        runtimeBaseUrl: "https://runtime.example",
        proxyTarget: "https://pim.aicuican.com",
      }),
    ).toBe("https://platform.example");
    expect(
      desktopAccountOriginForBuild({
        baseUrl: " ",
        apiBaseUrl: "https://alias.example/api",
        proxyTarget: "https://pim.aicuican.com",
      }),
    ).toBe("https://alias.example");
  });

  it("keeps an explicitly empty runtime backend on the original local fallback", () => {
    expect(
      desktopAccountOriginForBuild({
        runtimeBaseUrl: "",
        proxyTarget: "https://pim.aicuican.com",
      }),
    ).toBeNull();
  });

  it.each([
    "http://127.0.0.1:8000/",
    "http://localhost:8000/",
    "http://[::1]:8000/",
    "https://localhost:8000/",
  ])(
    "does not extend the transport for existing loopback target %s",
    (target) => {
      expect(desktopAccountOriginForBuild({ proxyTarget: target })).toBeNull();
    },
  );

  it.each([
    "http://pim.aicuican.com",
    "/agent-platform-api",
    "https://user:password@pim.aicuican.com",
    "https://pim.aicuican.com/?session=fixture",
    "https://pim.aicuican.com/#fragment",
  ])("rejects invalid public build target %j", (target) => {
    expect(() => desktopAccountOriginForBuild({ proxyTarget: target })).toThrow(
      "desktop_http_account_origin_invalid",
    );
  });
});
