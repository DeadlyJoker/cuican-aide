/**
 * Binds `desktopUpdate` to Electron's isolated updater bridge.
 *
 * Isolated from the policy so the policy stays testable without a webview, and
 * so the plugin modules are imported lazily: a browser build must not pull in
 * code that dials desktop IPC directly.
 */

import { detectRuntimeSurface } from "../platform";
import { getDesktopBridge } from "../desktop/desktopBridge";
import type { DownloadProgress, UpdaterPort } from "./desktopUpdate";

/**
 * Returns `null` on web, where there is nothing to update.
 *
 * The import is dynamic and inside the guard for a reason: eagerly importing the
 * plugin in a browser build throws at module-eval time, before any call site can
 * decide it does not care.
 */
export async function resolveUpdaterPort(): Promise<UpdaterPort | null> {
  if (detectRuntimeSurface() !== "desktop") {
    return null;
  }

  const bridge = getDesktopBridge();
  if (bridge === null) return null;

  return {
    async check() {
      const update = await bridge.updater.check();
      if (update === null) {
        return null;
      }
      return {
        version: update.version,
        notes: update.notes,
        async downloadAndInstall(
          onProgress: (event: DownloadProgress) => void,
        ) {
          const stop = bridge.updater.onProgress(onProgress);
          try {
            await bridge.updater.download();
          } finally {
            stop();
          }
        },
      };
    },
    relaunch: bridge.updater.relaunch,
  };
}
