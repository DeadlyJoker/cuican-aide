export type PlatformKind = "mac" | "windows" | "web";

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
