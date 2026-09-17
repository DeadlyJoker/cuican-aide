import type { DesktopHttpWireResult } from "../src/lib/desktop/desktopHttpProtocol.ts";

/** Expected stream cancellation must not make Electron log a stack per IPC read. */
export async function desktopHttpReply<T>(
  operation: () => T | Promise<T>,
): Promise<DesktopHttpWireResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return {
      ok: false,
      error: /^desktop_http_[a-z_]{1,64}$/.test(message)
        ? message
        : "desktop_http_transport_failed",
    };
  }
}
