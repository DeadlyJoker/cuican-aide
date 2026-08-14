/**
 * Binds `desktopUpdate` to the Tauri updater plugin.
 *
 * Isolated from the policy so the policy stays testable without a webview, and
 * so the plugin modules are imported lazily: a browser build must not pull in
 * code that dials `window.__TAURI_INTERNALS__`.
 */

import { hasDesktopBridge } from "../platform";
import type { DownloadProgress, UpdaterPort } from "./desktopUpdate";

/**
 * Returns `null` on web, where there is nothing to update.
 *
 * The import is dynamic and inside the guard for a reason: eagerly importing the
 * plugin in a browser build throws at module-eval time, before any call site can
 * decide it does not care.
 */
export async function resolveUpdaterPort(): Promise<UpdaterPort | null> {
  if (!hasDesktopBridge()) {
    return null;
  }

  const [{ check }, { relaunch }] = await Promise.all([
    import("@tauri-apps/plugin-updater"),
    import("@tauri-apps/plugin-process"),
  ]);

  return {
    async check() {
      const update = await check();
      if (update === null) {
        return null;
      }
      return {
        version: update.version,
        notes: update.body,
        downloadAndInstall: (onProgress: (event: DownloadProgress) => void) =>
          update.downloadAndInstall((event) =>
            onProgress(event as DownloadProgress),
          ),
      };
    },
    relaunch,
  };
}
