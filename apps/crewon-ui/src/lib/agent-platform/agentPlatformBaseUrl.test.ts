import { afterEach, describe, expect, it, vi } from "vitest";

import { agentPlatformBaseUrl } from "./agentPlatformClient";

/*
 * The packaged desktop build resolved `/agent-platform-api`, a Vite dev-server
 * proxy route that does not exist outside `pnpm dev`. Served from
 * `tauri://localhost`, WebKit rejected the request before it went anywhere and
 * the login screen showed "The string did not match the expected pattern" --
 * which reads like a validation bug and is really a missing proxy.
 */

function stubLocation(href: string) {
  const url = new URL(href);
  vi.stubGlobal("window", {
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
    stubLocation("tauri://localhost/index.html");

    expect(agentPlatformBaseUrl()).toBe("http://127.0.0.1:8000");
  });

  it("dials the backend directly from the Windows packaged webview", () => {
    // Windows serves the bundle over a synthetic http host, so the protocol
    // alone does not distinguish it from the dev server.
    stubLocation("http://tauri.localhost/index.html");

    expect(agentPlatformBaseUrl()).toBe("http://127.0.0.1:8000");
  });

  it("leaves an absolute override alone in a packaged build", () => {
    // A deployment pointing at a hosted backend must survive packaging.
    stubLocation("tauri://localhost/index.html");
    vi.stubEnv("VITE_AGENT_PLATFORM_BASE_URL", "https://platform.example/api");

    expect(agentPlatformBaseUrl()).toBe("https://platform.example/api");
  });

  it("rewrites a custom proxy path too, not just the default", () => {
    stubLocation("tauri://localhost/index.html");
    vi.stubEnv("VITE_AGENT_PLATFORM_BASE_URL", "/some-other-proxy");

    expect(agentPlatformBaseUrl()).toBe("http://127.0.0.1:8000");
  });

  it("strips a trailing slash so paths do not double up", () => {
    stubLocation("http://127.0.0.1:5175/");
    vi.stubEnv("VITE_AGENT_PLATFORM_BASE_URL", "https://platform.example/api/");

    expect(agentPlatformBaseUrl()).toBe("https://platform.example/api");
  });
});
