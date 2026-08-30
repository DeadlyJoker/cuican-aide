import { contextBridge, ipcRenderer } from "electron";

import {
  DESKTOP_BRIDGE_VERSION,
  type CrewonDesktopBridge,
  type DesktopHttpResponse,
  type DesktopUpdateInfo,
  type DesktopUpdateProgress,
} from "../src/lib/desktop/desktopBridge.ts";

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const bridge: CrewonDesktopBridge = {
  version: DESKTOP_BRIDGE_VERSION,
  runtime: {
    bootstrap: () => invoke<unknown>("crewon:runtime:bootstrap"),
    reloadProvider: () => invoke<void>("crewon:runtime:reload-provider"),
  },
  http: {
    fetch: (request) =>
      invoke<DesktopHttpResponse>("crewon:http:fetch", request),
  },
  sandbox: {
    listDirectory: (path) =>
      invoke<unknown>("crewon:sandbox:list-directory", path),
    readFile: (path) => invoke<unknown>("crewon:sandbox:read-file", path),
    readDiff: () => invoke<unknown>("crewon:sandbox:read-diff"),
    runCommand: (request) =>
      invoke<unknown>("crewon:sandbox:run-command", request),
  },
  workspace: {
    status: () => invoke<unknown>("crewon:workspace:status"),
    selectAndRegister: (request) =>
      invoke<unknown>("crewon:workspace:select-and-register", request),
    clear: (request) => invoke<unknown>("crewon:workspace:clear", request),
    pickDirectory: (title) =>
      invoke<string | null>("crewon:workspace:pick-directory", title),
  },
  providers: {
    catalog: () => invoke<unknown>("crewon:providers:catalog"),
    activate: (providerId) =>
      invoke<unknown>("crewon:providers:activate", providerId),
    delete: (providerId) =>
      invoke<unknown>("crewon:providers:delete", providerId),
    upsert: (request) => invoke<unknown>("crewon:providers:upsert", request),
  },
  window: {
    close: () => invoke<void>("crewon:window:close"),
    minimize: () => invoke<void>("crewon:window:minimize"),
    toggleMaximize: () => invoke<void>("crewon:window:toggle-maximize"),
    isMaximized: () => invoke<boolean>("crewon:window:is-maximized"),
    isFullscreen: () => invoke<boolean>("crewon:window:is-fullscreen"),
    onBoundsChanged: (listener) => {
      const handler = () => listener();
      ipcRenderer.on("crewon:window:bounds-changed", handler);
      return () =>
        ipcRenderer.removeListener("crewon:window:bounds-changed", handler);
    },
  },
  browser: {
    create: (id, url, bounds) =>
      invoke<void>("crewon:browser:create", id, url, bounds),
    updateBounds: (id, bounds) =>
      invoke<void>("crewon:browser:update-bounds", id, bounds),
    setVisible: (id, visible) =>
      invoke<void>("crewon:browser:set-visible", id, visible),
    destroy: (id) => invoke<void>("crewon:browser:destroy", id),
  },
  updater: {
    check: () => invoke<DesktopUpdateInfo | null>("crewon:updater:check"),
    download: () => invoke<void>("crewon:updater:download"),
    relaunch: () => invoke<void>("crewon:updater:relaunch"),
    onProgress: (listener) => {
      const handler = (_event: unknown, progress: DesktopUpdateProgress) =>
        listener(progress);
      ipcRenderer.on("crewon:updater:progress", handler);
      return () =>
        ipcRenderer.removeListener("crewon:updater:progress", handler);
    },
  },
  external: {
    open: (url) => invoke<void>("crewon:external:open", url),
  },
};

contextBridge.exposeInMainWorld("crewonDesktop", Object.freeze(bridge));
