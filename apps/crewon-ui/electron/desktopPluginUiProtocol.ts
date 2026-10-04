import type { BrowserWindow, Session, WebContents, IpcMain } from "electron";
import { DesktopPluginUiAssetBroker } from "./desktopPluginUiAssets.ts";

type Owner = Readonly<{
  contents: WebContents;
  broker: DesktopPluginUiAssetBroker;
}>;
const routers = new WeakMap<Session, Map<number, Owner>>();

export function bindDesktopPluginUiIpc(
  window: BrowserWindow,
  broker: DesktopPluginUiAssetBroker,
  ipc: IpcMain,
): void {
  const handle = (
    channel: string,
    operation: (...args: unknown[]) => unknown,
  ) => {
    ipc.handle(channel, (event, ...args) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !window.webContents.mainFrame.url.startsWith("file:")
      )
        throw new Error("desktop_plugin_ui_sender_invalid");
      return operation(...args);
    });
  };
  handle("crewon:plugin-ui:adopt-v1", (input) =>
    broker.adopt(input as Parameters<DesktopPluginUiAssetBroker["adopt"]>[0]),
  );
  handle("crewon:plugin-ui:release-v1", (ref) => broker.release(ref as string));
  handle("crewon:plugin-ui:renew-v1", (ref) => broker.renew(ref as string));
  handle("crewon:plugin-ui:invalidate-v1", () => broker.invalidate());
  window.webContents.once("destroyed", () => {
    for (const channel of [
      "crewon:plugin-ui:adopt-v1",
      "crewon:plugin-ui:release-v1",
      "crewon:plugin-ui:renew-v1",
      "crewon:plugin-ui:invalidate-v1",
    ])
      ipc.removeHandler(channel);
  });
}

/** Electron 43 protocol.handle has no initiating frame. The genuine Session gate is mandatory. */
export function bindDesktopPluginUiProtocol(
  window: BrowserWindow,
  broker: DesktopPluginUiAssetBroker,
  diagnostic: (code: string) => void,
) {
  const contents = window.webContents;
  const session = contents.session;
  let owners = routers.get(session);
  if (!owners) {
    owners = new Map();
    routers.set(session, owners);
    const currentOwners = owners;
    // No URL filter: Electron 43's <all_urls> matching need not include a private non-extension scheme.
    // This is the sole Session onBeforeRequest listener; unrelated requests remain unchanged.
    session.webRequest.onBeforeRequest((details, callback) => {
      if (!details.url.startsWith("crewon-plugin:")) return callback({});
      const owner =
        details.webContentsId === undefined
          ? null
          : currentOwners.get(details.webContentsId);
      const allowed =
        details.method === "GET" &&
        details.resourceType !== "mainFrame" &&
        details.resourceType !== "subFrame" &&
        !!owner &&
        !owner.contents.isDestroyed() &&
        details.webContents === owner.contents &&
        details.frame !== null &&
        details.frame === owner.contents.mainFrame &&
        owner.contents.mainFrame.url.startsWith("file:") &&
        owner.broker.allows(details.url);
      callback({ cancel: !allowed });
    });
    session.protocol.handle("crewon-plugin", async (request) => {
      // The opaque reference is scoped to exactly one genuine window owner; the Session gate checked its actual main frame.
      const owner = [...currentOwners.values()].find((v) =>
        v.broker.allows(request.url),
      );
      if (!owner) return new Response(null, { status: 404 });
      try {
        return await owner.broker.read(request);
      } catch {
        return new Response(null, {
          status: 404,
          headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }
    });
  }
  if (owners.has(contents.id))
    throw new Error("desktop_plugin_ui_owner_conflict");
  if (owners.size >= 8) throw new Error("desktop_plugin_ui_window_limit");
  owners.set(contents.id, Object.freeze({ contents, broker }));
  const invalidate = () => {
    void broker
      .invalidate()
      .catch(() => diagnostic("desktop_plugin_ui_cleanup_failed"));
  };
  const navigate = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ) => {
    if (details.isMainFrame && !details.isSameDocument) invalidate();
  };
  contents.on("did-start-navigation", navigate);
  contents.on("render-process-gone", invalidate);
  contents.once("destroyed", () => {
    owners.delete(contents.id);
    contents.off("did-start-navigation", navigate);
    contents.off("render-process-gone", invalidate);
    // Retain a failed physical owner in the session router until process shutdown.
    void broker.close().catch(() => {
      owners.set(contents.id, Object.freeze({ contents, broker }));
      diagnostic("desktop_plugin_ui_cleanup_failed");
    });
  });
}
