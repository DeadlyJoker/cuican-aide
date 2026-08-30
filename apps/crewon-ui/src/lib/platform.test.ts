import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultServerUrl, detectRuntimeSurface } from "./platform";

/*
 * `defaultServerUrl` decides what the app connects to, and it had no coverage at
 * all. The bug it hides: `/app-server` is a Vite dev-server proxy path, so a
 * packaged desktop build resolved a URL that only exists while `pnpm dev` runs.
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
});

describe("runtime surface", () => {
  it("reads web when no desktop bridge is present", () => {
    stubLocation("http://127.0.0.1:5175/");

    expect(detectRuntimeSurface()).toBe("web");
  });

  it("reads desktop when the Electron bridge is injected", () => {
    stubLocation("http://127.0.0.1:5175/");
    Object.defineProperty(window, "crewonDesktop", {
      configurable: true,
      value: { version: 1 },
    });

    expect(detectRuntimeSurface()).toBe("desktop");
  });

  it("honours an explicit surface override", () => {
    stubLocation("http://127.0.0.1:5175/?surface=desktop");

    expect(detectRuntimeSurface()).toBe("desktop");
  });
});

describe("default server URL", () => {
  it("uses the dev-server proxy path when served over http in a browser", () => {
    stubLocation("http://127.0.0.1:5175/");

    expect(defaultServerUrl()).toBe("ws://127.0.0.1:5175/app-server");
  });

  it("upgrades the proxy path to wss when the page is served over https", () => {
    stubLocation("https://crewon.example/");

    expect(defaultServerUrl()).toBe("wss://crewon.example/app-server");
  });

  it("prefers an explicit ?server= override", () => {
    stubLocation("http://127.0.0.1:5175/?server=ws%3A%2F%2F10.0.0.4%3A7000");

    expect(defaultServerUrl()).toBe("ws://10.0.0.4:7000");
  });

  it("routes a localhost app-server override through the proxy in the browser", () => {
    // Same-origin localhost on the default port is what the Vite proxy fronts.
    stubLocation("http://127.0.0.1:5175/?server=ws%3A%2F%2F127.0.0.1%3A6176");

    expect(defaultServerUrl()).toBe("ws://127.0.0.1:5175/app-server");
  });
});

/*
 * A packaged build has no dev server, so resolving `/app-server` left the desktop
 * app dialling a path that does not exist -- it sat on "connecting" forever. These
 * cover both platforms' packaged webview origins.
 */
describe("packaged desktop build", () => {
  it("dials the sidecar directly from the macOS packaged webview", () => {
    stubLocation("file:///Applications/CrewON.app/Contents/Resources/index.html");

    expect(defaultServerUrl()).toBe("ws://127.0.0.1:6176");
  });

  it("dials the sidecar directly from the Windows packaged webview", () => {
    stubLocation("file:///C:/Program%20Files/CrewON/resources/index.html");

    expect(defaultServerUrl()).toBe("ws://127.0.0.1:6176");
  });

  it("keeps a loopback override direct instead of rewriting it to the proxy", () => {
    stubLocation("file:///CrewON/index.html?server=ws%3A%2F%2F127.0.0.1%3A6176");

    expect(defaultServerUrl()).toBe("ws://127.0.0.1:6176");
  });

  it("still honours a remote override in a packaged build", () => {
    stubLocation(
      "file:///CrewON/index.html?server=wss%3A%2F%2Fcrewon.example%2Fapp",
    );

    expect(defaultServerUrl()).toBe("wss://crewon.example/app");
  });
});
