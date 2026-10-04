import { resolveAgentPlatformRuntimeBaseUrl } from "../src/lib/agent-platform/agentPlatformRuntimeBaseUrl.ts";

export type DesktopAccountTargetSettings = Readonly<{
  baseUrl?: string;
  apiBaseUrl?: string;
  runtimeBaseUrl?: string;
  proxyTarget?: string;
}>;

/** Only a canonical HTTPS origin can extend the existing loopback transport. */
export function parseDesktopTrustedAccountOrigin(
  value: unknown,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value || value.length > 2_048) invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid();
  }
  if (
    value !== url.origin ||
    url.protocol !== "https:" ||
    url.username ||
    url.password
  )
    invalid();
  return url.origin;
}

/** Match the Renderer target precedence using only public build configuration. */
export function desktopAccountOriginForBuild(
  settings: DesktopAccountTargetSettings,
): string | null {
  const configured =
    settings.baseUrl?.trim() ||
    settings.apiBaseUrl?.trim() ||
    "/agent-platform-api";
  let backend: string;
  try {
    backend = resolveAgentPlatformRuntimeBaseUrl(
      configured.startsWith("/")
        ? (settings.runtimeBaseUrl ?? settings.proxyTarget ?? "")
        : configured,
    );
  } catch {
    invalid();
  }
  const url = new URL(backend);
  if (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]"
  )
    return null;
  return parseDesktopTrustedAccountOrigin(url.origin);
}

function invalid(): never {
  throw new Error("desktop_http_account_origin_invalid");
}
