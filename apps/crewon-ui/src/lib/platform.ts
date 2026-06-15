export type PlatformKind = "mac" | "windows" | "web";

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

export function defaultServerUrl(): string {
  const configuredUrl = new URLSearchParams(window.location.search).get("server");

  if (configuredUrl) {
    return configuredUrl;
  }

  if (import.meta.env.VITE_CREWON_APP_SERVER_URL) {
    return import.meta.env.VITE_CREWON_APP_SERVER_URL;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/app-server`;
}
