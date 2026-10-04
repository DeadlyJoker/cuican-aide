import { afterEach, describe, expect, it, vi } from "vitest";

import {
  agentPlatformBaseUrl,
  agentPlatformInvocationUrl,
} from "./agentPlatformClient";

/*
 * The packaged desktop build resolved `/agent-platform-api`, a Vite dev-server
 * proxy route that does not exist outside `pnpm dev`. Served from
 * a `file:` URL, Chromium rejected the request before it went anywhere and
 * the login screen showed "The string did not match the expected pattern" --
 * which reads like a validation bug and is really a missing proxy.
 */

function stubLocation(href: string, options: { desktop?: boolean } = {}) {
  const url = new URL(href);
  vi.stubGlobal("window", {
    ...(options.desktop ? { crewonDesktop: { version: 1 } } : {}),
    location: {
      host: url.host,
      hostname: url.hostname,
      href: url.href,
      origin: url.origin,
      pathname: url.pathname,
      port: url.port,
      protocol: url.protocol,
      search: url.search,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("agent-platform base URL", () => {
  it("keeps the proxy route while the dev server is serving the page", () => {
    stubLocation("http://127.0.0.1:5175/");

    expect(agentPlatformBaseUrl()).toBe("/agent-platform-api");
  });

  it("dials the backend directly from the macOS packaged webview", () => {
    stubLocation(
      "file:///Applications/CrewON.app/Contents/Resources/index.html",
    );

    expect(agentPlatformBaseUrl()).toBe("http://127.0.0.1:8000");
  });

  it("dials the backend directly from the Windows packaged webview", () => {
    stubLocation("file:///C:/Program%20Files/CrewON/resources/index.html");

    expect(agentPlatformBaseUrl()).toBe("http://127.0.0.1:8000");
  });

  it("uses the configured runtime backend for packaged desktop login and Agent invocation", () => {
    stubLocation(
      "file:///Applications/CrewON.app/Contents/Resources/app.asar/dist/index.html",
      { desktop: true },
    );
    vi.stubEnv(
      "VITE_AGENT_PLATFORM_RUNTIME_BASE_URL",
      "https://pim.aicuican.com",
    );

    expect(agentPlatformBaseUrl()).toBe("https://pim.aicuican.com");
    expect(agentPlatformInvocationUrl("/api/v1/open/agent/93/chat")).toBe(
      "https://pim.aicuican.com/api/v1/open/agent/93/chat",
    );
  });

  it.each([
    "file:///C:/Program%20Files/CrewON/resources/index.html",
    "http://crewon.localhost/",
  ])("uses the configured runtime backend without a proxy at %s", (href) => {
    stubLocation(href, { desktop: true });
    vi.stubEnv("VITE_AGENT_PLATFORM_BASE_URL", "/custom-proxy");
    vi.stubEnv(
      "VITE_AGENT_PLATFORM_RUNTIME_BASE_URL",
      " https://platform.example/backend/ ",
    );

    expect(agentPlatformBaseUrl()).toBe("https://platform.example/backend");
  });

  it.each(["", "   "])(
    "keeps the local fallback for an empty runtime backend %j",
    (backend) => {
      stubLocation(
        "file:///Applications/CrewON.app/Contents/Resources/index.html",
        { desktop: true },
      );
      vi.stubEnv("VITE_AGENT_PLATFORM_RUNTIME_BASE_URL", backend);

      expect(agentPlatformBaseUrl()).toBe("http://127.0.0.1:8000");
    },
  );

  it("keeps the development proxy with a configured runtime backend", () => {
    stubLocation("http://127.0.0.1:5175/", { desktop: true });
    vi.stubEnv(
      "VITE_AGENT_PLATFORM_RUNTIME_BASE_URL",
      "https://pim.aicuican.com",
    );

    expect(agentPlatformBaseUrl()).toBe("/agent-platform-api");
  });

  it("keeps an absolute base override ahead of the runtime backend", () => {
    stubLocation(
      "file:///Applications/CrewON.app/Contents/Resources/index.html",
      { desktop: true },
    );
    vi.stubEnv("VITE_AGENT_PLATFORM_BASE_URL", "https://platform.example/api/");
    vi.stubEnv(
      "VITE_AGENT_PLATFORM_RUNTIME_BASE_URL",
      "https://pim.aicuican.com",
    );

    expect(agentPlatformBaseUrl()).toBe("https://platform.example/api");
    expect(agentPlatformInvocationUrl("/api/v1/open/agent/93/chat")).toBe(
      "https://platform.example/api/v1/open/agent/93/chat",
    );
  });

  it.each([
    "http://127.0.0.1:8000/",
    "http://localhost:8000/",
    "http://[::1]:8000/",
  ])("preserves the explicit loopback runtime backend %s", (backend) => {
    stubLocation(
      "file:///Applications/CrewON.app/Contents/Resources/index.html",
      { desktop: true },
    );
    vi.stubEnv("VITE_AGENT_PLATFORM_RUNTIME_BASE_URL", backend);

    expect(agentPlatformBaseUrl()).toBe(backend.slice(0, -1));
  });

  it.each([
    "/agent-platform-api",
    "//platform.example",
    "https:platform.example",
    "file:///tmp/platform",
    "javascript:alert(1)",
    "http://platform.example",
    "https://user:password@platform.example",
    "https://@platform.example",
    "https://platform.example/?session=value",
    "https://platform.example/?",
    "https://platform.example/#fragment",
    "https://platform.example/#",
    "https://platform.example/inner\npath",
    "https://platform.example:70000",
    `https://platform.example/${"x".repeat(2_048)}`,
  ])("rejects an invalid configured runtime backend %j", (backend) => {
    stubLocation(
      "file:///Applications/CrewON.app/Contents/Resources/index.html",
      { desktop: true },
    );
    vi.stubEnv("VITE_AGENT_PLATFORM_RUNTIME_BASE_URL", backend);

    expect(() => agentPlatformBaseUrl()).toThrow(
      "agent_platform_invocation_url_invalid",
    );
    expect(() =>
      agentPlatformInvocationUrl("/api/v1/open/agent/93/chat"),
    ).toThrow("agent_platform_invocation_url_invalid");
  });

  it("leaves an absolute override alone in a packaged build", () => {
    // A deployment pointing at a hosted backend must survive packaging.
    stubLocation(
      "file:///Applications/CrewON.app/Contents/Resources/index.html",
    );
    vi.stubEnv("VITE_AGENT_PLATFORM_BASE_URL", "https://platform.example/api");

    expect(agentPlatformBaseUrl()).toBe("https://platform.example/api");
  });

  it("rewrites a custom proxy path too, not just the default", () => {
    stubLocation(
      "file:///Applications/CrewON.app/Contents/Resources/index.html",
    );
    vi.stubEnv("VITE_AGENT_PLATFORM_BASE_URL", "/some-other-proxy");

    expect(agentPlatformBaseUrl()).toBe("http://127.0.0.1:8000");
  });

  it("strips a trailing slash so paths do not double up", () => {
    stubLocation("http://127.0.0.1:5175/");
    vi.stubEnv("VITE_AGENT_PLATFORM_BASE_URL", "https://platform.example/api/");

    expect(agentPlatformBaseUrl()).toBe("https://platform.example/api");
  });

  it("resolves a relative Agent invocation through the development proxy", () => {
    stubLocation("http://127.0.0.1:5175/");

    expect(agentPlatformInvocationUrl("/api/v1/open/agent/93/chat")).toBe(
      "http://127.0.0.1:5175/agent-platform-api/api/v1/open/agent/93/chat",
    );
  });

  it("dials PIM directly for a relative invocation from Electron development", () => {
    stubLocation("http://127.0.0.1:5175/", { desktop: true });
    vi.stubEnv(
      "VITE_AGENT_PLATFORM_RUNTIME_BASE_URL",
      "https://pim.aicuican.com",
    );

    expect(agentPlatformBaseUrl()).toBe("/agent-platform-api");
    expect(agentPlatformInvocationUrl("/api/v1/open/agent/93/chat")).toBe(
      "https://pim.aicuican.com/api/v1/open/agent/93/chat",
    );
  });

  it("resolves a relative Agent invocation against the packaged backend", () => {
    stubLocation(
      "file:///Applications/CrewON.app/Contents/Resources/index.html",
      { desktop: true },
    );
    vi.stubEnv(
      "VITE_AGENT_PLATFORM_RUNTIME_BASE_URL",
      "https://pim.aicuican.com",
    );

    expect(agentPlatformInvocationUrl("/api/v1/open/agent/93/chat")).toBe(
      "https://pim.aicuican.com/api/v1/open/agent/93/chat",
    );
  });

  it("keeps a hosted HTTPS Agent invocation URL", () => {
    stubLocation(
      "file:///Applications/CrewON.app/Contents/Resources/index.html",
    );
    vi.stubEnv("VITE_AGENT_PLATFORM_BASE_URL", "https://platform.example/api");

    expect(
      agentPlatformInvocationUrl(
        "https://platform.example/api/v1/open/agent/93/chat",
      ),
    ).toBe("https://platform.example/api/v1/open/agent/93/chat");
  });

  it("rejects an Agent invocation outside the authenticated platform origin", () => {
    stubLocation(
      "file:///Applications/CrewON.app/Contents/Resources/index.html",
    );
    vi.stubEnv("VITE_AGENT_PLATFORM_BASE_URL", "https://platform.example/api");

    expect(() =>
      agentPlatformInvocationUrl(
        "https://credential-collector.example/api/v1/open/agent/93/chat",
      ),
    ).toThrow("agent_platform_invocation_url_invalid");
  });
});
