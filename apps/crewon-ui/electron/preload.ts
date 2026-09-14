import { contextBridge, ipcRenderer } from "electron";

import {
  type AgentPlatformCredentialCatalog,
  type AgentPlatformCredentialUpsertRequest,
  DESKTOP_BRIDGE_VERSION,
  type CloudAgentProfileEntry,
  type CrewonDesktopBridge,
  type DesktopHttpResponse,
  type DesktopUpdateInfo,
  type DesktopUpdateProgress,
} from "../src/lib/desktop/desktopBridge.ts";
import {
  DESKTOP_HTTP_VERSION,
  type DesktopHttpReadResult,
  type DesktopHttpWireResult,
} from "../src/lib/desktop/desktopHttpProtocol.ts";

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const invokeHttp = async <T>(channel: string, value: unknown): Promise<T> => {
  const result = await invoke<DesktopHttpWireResult<T>>(channel, value);
  if (!result || typeof result.ok !== "boolean")
    throw new Error("desktop_http_version_incompatible");
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const bridge: CrewonDesktopBridge = {
  version: DESKTOP_BRIDGE_VERSION,
  agentPlatformCredentials: {
    catalog: () =>
      invoke<AgentPlatformCredentialCatalog>(
        "crewon:agent-platform-credentials:catalog",
      ),
    upsert: (request: AgentPlatformCredentialUpsertRequest) =>
      invoke<AgentPlatformCredentialCatalog>(
        "crewon:agent-platform-credentials:upsert",
        request,
      ),
    delete: (origin) =>
      invoke<AgentPlatformCredentialCatalog>(
        "crewon:agent-platform-credentials:delete",
        origin,
      ),
  },
  runtime: {
    bootstrap: () => invoke<unknown>("crewon:runtime:bootstrap"),
    reloadProvider: () => invoke<void>("crewon:runtime:reload-provider"),
    updateCloudAgentProfiles: (profiles) =>
      invoke<void>("crewon:runtime:update-cloud-agent-profiles", profiles),
  },
  http: {
    version: DESKTOP_HTTP_VERSION,
    fetch: (request) =>
      invokeHttp<DesktopHttpResponse>("crewon:http:open-v2", request),
    read: (requestId) =>
      invokeHttp<DesktopHttpReadResult>("crewon:http:read-v2", requestId),
    abort: (requestId) => invokeHttp<void>("crewon:http:abort-v2", requestId),
  },
  sandbox: {
    listDirectory: (path) =>
      invoke<unknown>("crewon:sandbox:list-directory", path),
    readFile: (path) => invoke<unknown>("crewon:sandbox:read-file", path),
    readGitSummary: () => invoke<unknown>("crewon:sandbox:read-git-summary"),
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
    modelCatalog: (request) =>
      invoke<unknown>("crewon:providers:model-catalog", request),
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
  browserExecution: {
    authorize: (input) => invoke("crewon:browser-execution:authorize", input),
    revoke: (threadId) => invoke("crewon:browser-execution:revoke", threadId),
    status: (threadId) => invoke("crewon:browser-execution:status", threadId),
  },
  recording: {
    open: () => invoke<void>("crewon:recording:open"),
    onSkillImportRequest: (listener) => {
      const handler = (
        _event: unknown,
        request: import("../src/lib/desktop/recordingBridge.ts").RecordingSkillImportRequest,
      ) => {
        void Promise.resolve()
          .then(() => listener(request))
          .then(
            (result) =>
              invoke<void>(
                "crewon:recording:skill-result",
                request.requestId,
                result,
              ),
            () =>
              invoke<void>("crewon:recording:skill-result", request.requestId, {
                ok: false,
                message: "Skill 导入失败，请在主窗口检查。",
              }),
          )
          .catch(() => undefined);
      };
      ipcRenderer.on("crewon:recording:skill-request", handler);
      void invoke<void>("crewon:recording:skill-listening", true);
      return () => {
        ipcRenderer.removeListener("crewon:recording:skill-request", handler);
        void invoke<void>("crewon:recording:skill-listening", false);
      };
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
