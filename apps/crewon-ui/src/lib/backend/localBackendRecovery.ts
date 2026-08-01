export type LocalBackendRestartResult = "failed" | "requested" | "unsupported";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const LOCAL_BACKEND_RESTART_PATH = "/__crewon/dev/restart-app-server";

export async function requestLocalAppServerRestart({
  fetchImpl = globalThis.fetch,
  hostname = globalThis.location?.hostname ?? "",
}: {
  fetchImpl?: typeof fetch;
  hostname?: string;
} = {}): Promise<LocalBackendRestartResult> {
  if (!LOOPBACK_HOSTNAMES.has(hostname) || !fetchImpl) {
    return "unsupported";
  }

  try {
    const response = await fetchImpl(LOCAL_BACKEND_RESTART_PATH, {
      headers: {
        "x-crewon-recovery-request": "office-catalog",
      },
      method: "POST",
    });
    if (response.status === 202) {
      return "requested";
    }
    if (response.status === 404 || response.status === 501) {
      return "unsupported";
    }
    return "failed";
  } catch {
    return "failed";
  }
}
