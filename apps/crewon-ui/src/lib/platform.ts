export type PlatformKind = "mac" | "windows" | "web";

/**
 * Operating system and runtime surface are orthogonal: CrewON runs in the
 * browser and as a desktop app, and both can be hosted on either OS. Keeping
 * them separate avoids "web means not macOS" bugs in platform-specific UI.
 */
export type OperatingSystem = "linux" | "mac" | "windows";
export type RuntimeSurface = "desktop" | "web";

const LOCALHOST_NAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const DEFAULT_APP_SERVER_PORT = "6176";

export function detectPlatform(): PlatformKind {
  const platformOverride = new URLSearchParams(window.location.search).get(
    "platform",
  );
  if (
    platformOverride === "mac" ||
    platformOverride === "windows" ||
    platformOverride === "web"
  ) {
    return platformOverride;
  }

  const userAgent = navigator.userAgent.toLowerCase();

  if (userAgent.includes("mac")) {
    return "mac";
  }

  if (userAgent.includes("win")) {
    return "windows";
  }

  return "web";
}

/*
 * Returns null when there is no DOM. Surface detection now runs during render of
 * the window chrome, which unit tests mount without a location, and a throw
 * there would take the whole tree down over a debug-only query parameter.
 */
function overrideParam(name: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return new URLSearchParams(window.location.search).get(name);
}

export function detectOperatingSystem(): OperatingSystem {
  const override = overrideParam("os");
  if (override === "linux" || override === "mac" || override === "windows") {
    return override;
  }

  const platformHint =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? "";
  const probe = `${platformHint} ${navigator.userAgent}`.toLowerCase();

  if (
    probe.includes("mac") ||
    probe.includes("iphone") ||
    probe.includes("ipad")
  ) {
    return "mac";
  }
  if (probe.includes("win")) {
    return "windows";
  }
  return "linux";
}

export function detectRuntimeSurface(): RuntimeSurface {
  const override = overrideParam("surface");
  if (override === "desktop" || override === "web") {
    return override;
  }

  return hasDesktopBridge() ? "desktop" : "web";
}

/**
 * Whether Tauri's IPC bridge is actually present, ignoring `?surface=`.
 *
 * `detectRuntimeSurface` answers "which chrome should this look like", which the
 * override is allowed to fake. This answers "can we call into the host", which it
 * is not: faking it makes every IPC call fail inside the plugin instead.
 */
export function hasDesktopBridge(): boolean {
  // Tauri injects these globals into the desktop webview.
  return "isTauri" in globalThis || "__TAURI_INTERNALS__" in globalThis;
}

/**
 * `/app-server` is served by the Vite dev server, which proxies it to the local
 * app-server. It only exists while `pnpm dev` runs.
 */
function proxiedServerUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/app-server`;
}

/**
 * A packaged desktop build loads from `tauri://` or `http://tauri.localhost`, so
 * there is no dev server to proxy through and the app talks to the sidecar
 * app-server directly on the loopback port.
 */
function sidecarServerUrl(): string {
  return `ws://127.0.0.1:${DEFAULT_APP_SERVER_PORT}`;
}

/**
 * Whether this page is served by the Vite dev server rather than from a packaged
 * bundle. `tauri dev` also loads over http from the dev server, and in that case
 * the proxy is present and should be used.
 *
 * Exported because every same-origin proxy path has this problem, not just the
 * app-server socket: a packaged build resolving one asks the webview for a path
 * that nothing serves.
 */
export function hasDevServerProxy(): boolean {
  // No document at all: a unit test or any other non-DOM host. Reporting "no
  // proxy" would rewrite same-origin paths to a hardcoded backend origin, so a
  // test asserting on a request URL would see one it never configured. Treating
  // it as proxied keeps a relative path relative, which is what callers outside
  // a browser mean by it.
  if (typeof window === "undefined") {
    return true;
  }

  const { hostname, protocol } = window.location;
  // A location without these is not a real page either -- a partial stub, most
  // likely. Same reasoning as a missing `window`: guessing "packaged" would
  // rewrite URLs the caller never asked to have rewritten.
  if (typeof protocol !== "string" || typeof hostname !== "string") {
    return true;
  }

  if (protocol !== "http:" && protocol !== "https:") {
    return false;
  }
  // The packaged webview serves the bundle from a synthetic http host on
  // Windows, which looks like http but has no dev server behind it.
  return !hostname.endsWith(".localhost");
}

function localhostName(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, "$1");
}

function shouldUseLocalProxy(configuredUrl: string): boolean {
  // Without a dev server there is nothing to proxy through, so a loopback URL
  // has to be dialled directly.
  if (!hasDevServerProxy()) {
    return false;
  }
  try {
    const url = new URL(configuredUrl);
    return (
      (url.protocol === "ws:" || url.protocol === "wss:") &&
      url.port === DEFAULT_APP_SERVER_PORT &&
      LOCALHOST_NAMES.has(localhostName(url.hostname)) &&
      LOCALHOST_NAMES.has(localhostName(window.location.hostname))
    );
  } catch {
    return false;
  }
}

function configuredServerUrl(configuredUrl: string): string {
  return shouldUseLocalProxy(configuredUrl)
    ? proxiedServerUrl()
    : configuredUrl;
}

export function defaultServerUrl(): string {
  const configuredUrl = new URLSearchParams(window.location.search).get(
    "server",
  );

  if (configuredUrl) {
    return configuredServerUrl(configuredUrl);
  }

  if (import.meta.env.VITE_CREWON_APP_SERVER_URL) {
    return configuredServerUrl(import.meta.env.VITE_CREWON_APP_SERVER_URL);
  }

  return hasDevServerProxy() ? proxiedServerUrl() : sidecarServerUrl();
}
