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
  const platformOverride = new URLSearchParams(window.location.search).get("platform");
  if (platformOverride === "mac" || platformOverride === "windows" || platformOverride === "web") {
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

function overrideParam(name: string): string | null {
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

  if (probe.includes("mac") || probe.includes("iphone") || probe.includes("ipad")) {
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

  // Tauri injects this global into the desktop webview.
  return "isTauri" in globalThis || "__TAURI_INTERNALS__" in globalThis
    ? "desktop"
    : "web";
}

function proxiedServerUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/app-server`;
}

function localhostName(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, "$1");
}

function shouldUseLocalProxy(configuredUrl: string): boolean {
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
  return shouldUseLocalProxy(configuredUrl) ? proxiedServerUrl() : configuredUrl;
}

export function defaultServerUrl(): string {
  const configuredUrl = new URLSearchParams(window.location.search).get("server");

  if (configuredUrl) {
    return configuredServerUrl(configuredUrl);
  }

  if (import.meta.env.VITE_CREWON_APP_SERVER_URL) {
    return configuredServerUrl(import.meta.env.VITE_CREWON_APP_SERVER_URL);
  }

  return proxiedServerUrl();
}
