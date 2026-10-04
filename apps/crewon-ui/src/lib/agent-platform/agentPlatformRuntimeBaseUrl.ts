/** Fallback when Vite's runtime backend is not explicitly configured. */
const DEFAULT_RUNTIME_BASE_URL = "http://127.0.0.1:8000";

/** Resolves an absolute backend without carrying the development proxy prefix. */
export function resolveAgentPlatformRuntimeBaseUrl(value: string): string {
  const configured = value.trim();
  if (!configured) return DEFAULT_RUNTIME_BASE_URL;
  if (
    configured.length > 2_048 ||
    /[\u0000-\u0020\u007f?#]/u.test(configured) ||
    !/^https?:\/\//u.test(configured) ||
    /^https?:\/\/[^/]*@/u.test(configured)
  )
    throw new Error("agent_platform_invocation_url_invalid");
  let backend: URL;
  try {
    backend = new URL(configured);
  } catch {
    throw new Error("agent_platform_invocation_url_invalid");
  }
  const loopback =
    backend.hostname === "localhost" ||
    backend.hostname === "127.0.0.1" ||
    backend.hostname === "[::1]";
  if (
    backend.username ||
    backend.password ||
    backend.search ||
    backend.hash ||
    (backend.protocol !== "https:" &&
      !(backend.protocol === "http:" && loopback))
  )
    throw new Error("agent_platform_invocation_url_invalid");
  return configured.replace(/\/+$/, "");
}
