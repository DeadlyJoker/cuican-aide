/** Public endpoints only. Account credentials must never be embedded in builds. */
const DESKTOP_ACCOUNT_ORIGIN = "https://pim.aicuican.com";
const DEVELOPMENT_ACCOUNT_ORIGIN = "http://127.0.0.1:8000";

export function agentPlatformBuildConfig(
  mode: string,
  env: Record<string, string | undefined>,
): { proxyTarget: string; runtimeBaseUrl: string; accountBaseUrl: string } {
  const configuredBase =
    env.VITE_AGENT_PLATFORM_BASE_URL?.trim() ||
    env.VITE_AGENT_PLATFORM_API_BASE_URL?.trim();
  const proxyTarget =
    env.CREWON_AGENT_PLATFORM_TARGET?.trim() ||
    (mode === "desktop" ? DESKTOP_ACCOUNT_ORIGIN : DEVELOPMENT_ACCOUNT_ORIGIN);
  const runtimeBaseUrl =
    env.VITE_AGENT_PLATFORM_RUNTIME_BASE_URL?.trim() ||
    (configuredBase && !configuredBase.startsWith("/")
      ? configuredBase
      : proxyTarget);
  const accountBaseUrl =
    configuredBase && !configuredBase.startsWith("/")
      ? configuredBase
      : runtimeBaseUrl;

  if (mode === "desktop") {
    // Fail at packaging time instead of shipping an unusable file:// proxy URL.
    for (const value of [proxyTarget, runtimeBaseUrl, accountBaseUrl]) {
      const url = new URL(value);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
        url.hostname,
      );
      if (
        (url.protocol !== "https:" &&
          !(url.protocol === "http:" && loopback)) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error(
          "Desktop account endpoint must use HTTPS (HTTP only on loopback), without credentials, query, or fragment",
        );
      }
    }
  }
  return {
    proxyTarget,
    runtimeBaseUrl: runtimeBaseUrl.replace(/\/+$/, ""),
    accountBaseUrl: accountBaseUrl.replace(/\/+$/, ""),
  };
}
