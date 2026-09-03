import type { DesktopRectangle } from "../../lib/desktop/desktopBridge";

export type NativeBrowserViewClient = {
  create(id: string, url: string, bounds: DesktopRectangle): Promise<void>;
  destroy(id: string): Promise<void>;
  setVisible(id: string, visible: boolean): Promise<void>;
  updateBounds(id: string, bounds: DesktopRectangle): Promise<void>;
};

export type NativeBrowserViewGeneration = {
  completion: Promise<"disposed" | "ready">;
  dispose(): Promise<void>;
};

let nativeBrowserViewSequence = 0;
const NATIVE_BROWSER_VIEW_PREFIX = "crewon-workbench-browser-";
const MAX_NATIVE_BROWSER_VIEW_ID_LENGTH = 128;

/**
 * Every effect generation owns a distinct native view id. A URL change or tab
 * remount can therefore finish its old async create without deleting the newer
 * view that replaced it.
 */
export function allocateNativeBrowserViewId(instanceId: string): string {
  nativeBrowserViewSequence =
    (nativeBrowserViewSequence % Number.MAX_SAFE_INTEGER) + 1;
  const suffix = nativeBrowserViewSequence.toString(36);
  const maxInstanceLength =
    MAX_NATIVE_BROWSER_VIEW_ID_LENGTH -
    NATIVE_BROWSER_VIEW_PREFIX.length -
    suffix.length -
    1;
  const safeInstance =
    instanceId.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, maxInstanceLength) ||
    "tab";
  return `${NATIVE_BROWSER_VIEW_PREFIX}${safeInstance}-${suffix}`;
}

/**
 * Own the part of native BrowserView creation that can outlive a React effect.
 * The Electron host creates views hidden; after creation settles, the React
 * owner applies current bounds and visibility. Disposal always targets this
 * generation's unique id, including when create resolves late.
 */
export function startNativeBrowserViewGeneration({
  browser,
  getBounds,
  id,
  url,
}: {
  browser: NativeBrowserViewClient;
  getBounds: () => DesktopRectangle | null;
  id: string;
  url: string;
}): NativeBrowserViewGeneration {
  let disposed = false;

  const destroyQuietly = async () => {
    try {
      await browser.destroy(id);
    } catch {
      // A disposed React effect has no surface left on which to report cleanup.
    }
  };

  const completion = (async (): Promise<"disposed" | "ready"> => {
    try {
      await browser.destroy(id);
      if (disposed) return "disposed";

      const bounds = getBounds();
      if (!bounds) return "disposed";

      await browser.create(id, url, bounds);
      if (disposed) {
        await destroyQuietly();
        return "disposed";
      }

      // Reinforce the host's hidden-by-default contract after the deferred
      // load. The React owner will position this generation using fresh bounds
      // before it is ever allowed to become visible.
      await browser.setVisible(id, false);
      if (disposed) {
        await destroyQuietly();
        return "disposed";
      }
      return "ready";
    } catch (error) {
      if (disposed) {
        await destroyQuietly();
        return "disposed";
      }
      throw error;
    }
  })();

  return {
    completion,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await destroyQuietly();
    },
  };
}

/** Update current geometry before revealing a still-owned native view. */
export async function syncNativeBrowserViewForReveal({
  bounds,
  browser,
  id,
  isCurrent,
  isObscured,
}: {
  bounds: DesktopRectangle;
  browser: NativeBrowserViewClient;
  id: string;
  isCurrent: () => boolean;
  isObscured: () => boolean;
}): Promise<void> {
  await browser.updateBounds(id, bounds);
  if (!isCurrent()) return;
  await browser.setVisible(id, !isObscured());
}
