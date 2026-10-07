import { discardInterruptedDesktopConfigWrites } from "./desktopConfigFile.ts";
import { ControlApiClientError } from "@crewon/control-client";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  type IpcMainInvokeEvent,
} from "electron";
import electronUpdater from "electron-updater";

declare const __CREWON_DESKTOP_TRUSTED_ACCOUNT_ORIGIN__: string | null;

import type {
  DesktopPluginSelectionReply,
  DesktopHttpRequest,
  DesktopUpdateProgress,
} from "../src/lib/desktop/desktopBridge.ts";
import { BrowserViewManager, openExternal } from "./browserViews.ts";
import {
  AgentPlatformCredentialStore,
  parseAgentPlatformOrigin,
} from "./agentPlatformCredentials.ts";
import { DesktopHttpTransport } from "./desktopHttp.ts";
import { bindDesktopHttpLifetime } from "./desktopHttpLifetime.ts";
import { desktopHttpReply } from "./desktopHttpReply.ts";
import { DesktopPluginUiAssetBroker } from "./desktopPluginUiAssets.ts";
import { bindDesktopLocalPluginSourceImportIpc } from "./desktopLocalPluginSourceImportIpc.ts";
import { bindDesktopLocalPluginExecutionSetupIpc } from "./desktopLocalPluginExecutionSetupIpc.ts";
import { recoverDesktopLocalPluginSourceImport } from "./desktopLocalPluginSourceImport.ts";
import {
  bindDesktopPluginUiProtocol,
  bindDesktopPluginUiIpc,
} from "./desktopPluginUiProtocol.ts";
import {
  LocalWorkspaceAuthority,
  LocalWorkspaceSandbox,
} from "./localWorkspace.ts";
import { loadLocalEnvironment } from "./localEnvironment.ts";
import { bindDesktopWindowActivation } from "./desktopWindowActivation.ts";
import { providerModelCatalogForForm } from "./providerModelCatalog.ts";
import { ProviderCredentialStore } from "./providerCredentials.ts";
import { loadDesktopInstalledPluginRuntimeConfiguration } from "./desktopInstalledPluginRuntimeConfiguration.ts";
import { RuntimeSupervisor, runtimePaths } from "./runtimeSupervisor.ts";
import { loadDesktopExtensionRuntimeConfiguration } from "./desktopExtensionRuntime.ts";
import {
  closeProcessRuntimeLogs,
  processRuntimeLogs,
} from "./processRuntimeLogs.ts";
export { processRuntimeLogStatus } from "./processRuntimeLogs.ts";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = electronUpdater;
const developmentRepositoryRoot = resolve(moduleDirectory, "../../..");
const repositoryRoot = app.isPackaged
  ? null
  : resolve(
      process.env.CREWON_REPOSITORY_ROOT?.trim() || developmentRepositoryRoot,
    );
const remoteDebuggingPort = process.env.CREWON_REMOTE_DEBUGGING_PORT?.trim();
if (remoteDebuggingPort && /^\d{4,5}$/u.test(remoteDebuggingPort)) {
  app.commandLine.appendSwitch("remote-debugging-port", remoteDebuggingPort);
}

const ownsInstance = app.requestSingleInstanceLock();
protocol.registerSchemesAsPrivileged([
  {
    scheme: "crewon-plugin",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
desktopLog(`starting (singleInstance=${ownsInstance})`);
if (!ownsInstance) {
  app.quit();
} else {
  void app
    .whenReady()
    .then(async () => {
      desktopLog("Electron ready");
      await launch();
    })
    .catch((error) => {
      processRuntimeLogs().write(
        "stderr",
        "CrewON desktop",
        `failed: ${errorMessage(error)}\n`,
      );
      app.quit();
    });
}

async function launch(): Promise<void> {
  loadLocalEnvironment({
    packaged: app.isPackaged,
    repositoryRoot,
    resourcesPath: process.resourcesPath,
  });
  const runtimeDataDirectory = join(
    app.getPath("userData"),
    "control-runtime-v1",
  );
  const configurationCleanup = discardInterruptedDesktopConfigWrites({
    dataDirectory: runtimeDataDirectory,
    ownsSingleInstance: ownsInstance,
  });
  if (configurationCleanup.retained > 0) {
    desktopLog(
      `configuration staging retained: ${configurationCleanup.retained}`,
    );
  }
  const sourceImportRecovery = recoverDesktopLocalPluginSourceImport({
    dataDirectory: runtimeDataDirectory,
    ownsSingleInstance: ownsInstance,
  });
  if (sourceImportRecovery.retained)
    desktopLog("desktop_plugin_source_import_staging_retained");
  const authority = new LocalWorkspaceAuthority(
    runtimeDataDirectory,
    process.env.CREWON_DESKTOP_WORKSPACE_ROOT?.trim() ||
      repositoryRoot ||
      undefined,
  );
  const sandbox = new LocalWorkspaceSandbox(authority);
  const agentPlatformCredentials = new AgentPlatformCredentialStore(
    runtimeDataDirectory,
    safeStorage,
  );
  let runtime: RuntimeSupervisor | null = null;
  const paths = runtimePaths({
    packaged: app.isPackaged,
    repositoryRoot: repositoryRoot ?? process.resourcesPath,
    resourcesPath: process.resourcesPath,
  });
  const providers = new ProviderCredentialStore(
    runtimeDataDirectory,
    async () => {
      await runtime?.restart();
    },
  );
  runtime = new RuntimeSupervisor({
    agentPlatformApiKeyForOrigin: (origin) =>
      agentPlatformCredentials.secretForOrigin(origin),
    dataDirectory: runtimeDataDirectory,
    extensionRuntime: {
      configuration: () =>
        loadDesktopExtensionRuntimeConfiguration(runtimeDataDirectory),
      resolveProviderCredential: (binding) =>
        providers.resolveForRuntime(binding),
    },
    installedRuntime: {
      configuration: () =>
        loadDesktopInstalledPluginRuntimeConfiguration(runtimeDataDirectory),
    },
    paths,
    repositoryRoot,
    provider: () => providers.active(),
    providerModelCatalog: async (provider) => {
      const result = await providerModelCatalogForForm(
        {
          apiKey: provider.apiKey,
          defaultModelId: provider.modelId,
          endpoint: provider.endpoint,
          environmentVariable: null,
          providerId: provider.providerId,
        },
        { paths, providers },
      );
      return result.status === "ok" ? result.models : null;
    },
  });
  desktopLog(`provider=${providers.active()?.providerId ?? "unconfigured"}`);
  await runtime.start().catch((error) => {
    processRuntimeLogs().write(
      "stderr",
      "CrewON runtime",
      `unavailable: ${errorMessage(error)}\n`,
    );
  });

  const window = createWindow();
  const pluginSourceImports = bindDesktopLocalPluginSourceImportIpc({
    window,
    ipc: ipcMain,
    dataDirectory: runtimeDataDirectory,
    rendererUrl:
      process.env.CREWON_UI_DEV_URL?.trim() ||
      pathToFileURL(join(moduleDirectory, "../dist/index.html")).href,
    runtime,
    chooseDirectory: async () => {
      const result = await dialog.showOpenDialog(window, {
        title: "选择已构建的 CrewON 插件目录",
        properties: ["openDirectory"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    diagnostic: desktopLog,
  });
  const pluginExecutionSetup = bindDesktopLocalPluginExecutionSetupIpc({
    window,
    ipc: ipcMain,
    dataDirectory: runtimeDataDirectory,
    rendererUrl:
      process.env.CREWON_UI_DEV_URL?.trim() ||
      pathToFileURL(join(moduleDirectory, "../dist/index.html")).href,
    runtime,
    diagnostic: desktopLog,
  });
  desktopLog("window created");
  const browserViews = new BrowserViewManager(window);
  const pluginUiAssets = new DesktopPluginUiAssetBroker({
    controlOwner: () => runtime.currentControlOwner(),
    session: () => ({
      ...runtime.session(),
      generation: runtime.sessionGeneration,
    }),
    onDiagnostic: desktopLog,
  });
  bindDesktopPluginUiProtocol(window, pluginUiAssets, desktopLog);
  const removeSessionListener = runtime.onSessionInvalidated(() => {
    return pluginUiAssets.invalidate();
  });
  const removeLocalManagementListener = runtime.onLocalManagementAccessChanged(
    () => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(
          "crewon:runtime:local-management-access-changed",
        );
    },
  );
  registerIpc({
    agentPlatformCredentials,
    authority,
    browserViews,
    paths,
    providers,
    pluginUiAssets,
    runtime,
    sandbox,
    window,
  });
  await loadRenderer(window);
  desktopLog("renderer loaded");

  window.on("closed", () => {
    removeLocalManagementListener();
    browserViews.destroyAll();
  });
  app.on("window-all-closed", () => app.quit());
  let quitting = false;
  const removeWindowActivation = bindDesktopWindowActivation({
    app,
    window,
    isQuitting: () => quitting,
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    removeWindowActivation();
    removeSessionListener();
    removeLocalManagementListener();
    void Promise.allSettled([
      pluginSourceImports.close(),
      pluginExecutionSetup.close(),
    ])
      .then((results) => {
        if (results.some((result) => result.status === "rejected"))
          desktopLog("desktop_plugin_management_cleanup_failed");
      })
      .then(() => pluginUiAssets.close())
      .catch(() => desktopLog("desktop_plugin_ui_cleanup_failed"))
      .then(() => runtime?.stop())
      .catch(() => desktopLog("runtime_shutdown_failed"))
      .finally(() => app.quit());
  });
  app.on("will-quit", closeProcessRuntimeLogs);
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    // Custom titlebar buttons should respond on the first click from another app.
    acceptFirstMouse: true,
    transparent: process.platform === "darwin",
    backgroundColor: "#00000000",
    show: false,
    webPreferences: {
      preload: join(moduleDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.once("ready-to-show", () => window.show());
  const logWindowEvent = (event: string) => () =>
    processRuntimeLogs().write("stdout", "CrewON window", `${event}\n`);
  window.on("minimize", logWindowEvent("minimize"));
  window.on("restore", logWindowEvent("restore"));
  window.on("closed", logWindowEvent("closed"));
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const developmentUrl = process.env.CREWON_UI_DEV_URL?.trim();
    const allowed = developmentUrl
      ? new URL(url).origin === new URL(developmentUrl).origin
      : url.startsWith("file:");
    if (!allowed) event.preventDefault();
  });
  const notifyBounds = () =>
    window.webContents.send("crewon:window:bounds-changed");
  window.on("resize", notifyBounds);
  window.on("maximize", notifyBounds);
  window.on("unmaximize", notifyBounds);
  window.on("enter-full-screen", notifyBounds);
  window.on("leave-full-screen", notifyBounds);
  return window;
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  const developmentUrl = process.env.CREWON_UI_DEV_URL?.trim();
  if (developmentUrl) {
    await window.loadURL(developmentUrl);
    if (process.env.CREWON_OPEN_DEVTOOLS === "1")
      window.webContents.openDevTools({ mode: "detach" });
    return;
  }
  await window.loadFile(join(moduleDirectory, "../dist/index.html"));
}

function registerIpc(options: {
  agentPlatformCredentials: AgentPlatformCredentialStore;
  authority: LocalWorkspaceAuthority;
  browserViews: BrowserViewManager;
  paths: ReturnType<typeof runtimePaths>;
  providers: ProviderCredentialStore;
  pluginUiAssets: DesktopPluginUiAssetBroker;
  runtime: RuntimeSupervisor;
  sandbox: LocalWorkspaceSandbox;
  window: BrowserWindow;
}): void {
  const {
    agentPlatformCredentials,
    authority,
    browserViews,
    paths,
    providers,
    pluginUiAssets,
    runtime,
    sandbox,
    window,
  } = options;
  const desktopHttp = new DesktopHttpTransport({
    trustedAccountOrigin:
      typeof __CREWON_DESKTOP_TRUSTED_ACCOUNT_ORIGIN__ === "undefined"
        ? null
        : __CREWON_DESKTOP_TRUSTED_ACCOUNT_ORIGIN__,
  });
  const handle = <T extends unknown[]>(
    channel: string,
    listener: (...args: T) => unknown,
  ) => {
    ipcMain.handle(channel, (event, ...args) => {
      requireMainRenderer(event, window);
      return listener(...(args as T));
    });
  };

  handle("crewon:runtime:bootstrap", () => runtime.session());
  handle(
    "crewon:plugins:set-selection",
    async (request: unknown): Promise<DesktopPluginSelectionReply> => {
      try {
        return { ok: true, value: await runtime.setPluginSelection(request) };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof ControlApiClientError
              ? {
                  kind: "http",
                  status: error.status,
                  category: error.category,
                  code: error.code,
                  message: error.message,
                  requestId: error.requestId,
                }
              : {
                  kind: "unknown",
                  code: "desktop_native_plugin_business_activation_failed",
                },
        };
      }
    },
  );
  handle("crewon:runtime:local-management-access", () =>
    runtime.localManagementAccess(),
  );
  bindDesktopPluginUiIpc(window, pluginUiAssets, ipcMain);
  handle("crewon:agent-platform-credentials:catalog", () =>
    agentPlatformCredentials.catalog(),
  );
  handle(
    "crewon:agent-platform-credentials:upsert",
    async (request: unknown) => {
      const origin = parseAgentPlatformOrigin(
        typeof request === "object" && request !== null && "origin" in request
          ? request.origin
          : null,
      );
      const catalog = agentPlatformCredentials.upsert(request);
      await runtime.agentPlatformCredentialChanged(origin);
      return catalog;
    },
  );
  handle("crewon:agent-platform-credentials:delete", async (value: unknown) => {
    const origin = parseAgentPlatformOrigin(value);
    const catalog = agentPlatformCredentials.delete(origin);
    await runtime.agentPlatformCredentialChanged(origin);
    return catalog;
  });
  handle("crewon:runtime:reload-provider", () => runtime.restart());
  handle(
    "crewon:runtime:update-cloud-agent-profiles",
    async (
      profiles: readonly {
        agentVersionId: string;
        instructions: string;
        invocationUrl: string;
        modelId: string;
        agentId: number;
      }[],
    ) => runtime.updateCloudAgentProfiles(profiles),
  );
  handle("crewon:http:open-v2", (request: DesktopHttpRequest) =>
    desktopHttpReply(() => desktopHttp.fetch(request)),
  );
  handle("crewon:http:read-v2", (requestId: string) =>
    desktopHttpReply(() => desktopHttp.read(requestId)),
  );
  handle("crewon:http:abort-v2", (requestId: string) =>
    desktopHttpReply(() => desktopHttp.abort(requestId)),
  );
  bindDesktopHttpLifetime(window.webContents, desktopHttp);
  handle("crewon:sandbox:list-directory", (path?: string) =>
    sandbox.listDirectory(path),
  );
  handle("crewon:sandbox:read-file", (path: string) => sandbox.readFile(path));
  handle("crewon:sandbox:read-git-summary", () => sandbox.readGitSummary());
  handle("crewon:sandbox:read-diff", () => sandbox.readDiff());
  handle("crewon:sandbox:run-command", (request: unknown) =>
    sandbox.runCommand(request),
  );
  handle("crewon:workspace:status", () => authority.status());
  handle("crewon:workspace:pick-directory", async (title?: string) => {
    const result = await dialog.showOpenDialog(window, {
      title: typeof title === "string" ? title : undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle("crewon:workspace:select-and-register", async (request: unknown) => {
    const result = await dialog.showOpenDialog(window, {
      title: "新增本地工作空间",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths[0] === undefined)
      return authority.canceled(request);
    return authority.select(result.filePaths[0], request);
  });
  handle("crewon:workspace:activate", (workspaceId: string, request: unknown) =>
    authority.activate(workspaceId, request),
  );
  handle("crewon:workspace:clear", (request: unknown) =>
    authority.clear(request),
  );
  handle("crewon:providers:catalog", () => providers.catalog());
  handle("crewon:providers:activate", (providerId: string) =>
    providers.activate(providerId),
  );
  handle("crewon:providers:delete", (providerId: string) =>
    providers.delete(providerId),
  );
  handle("crewon:providers:upsert", (request: unknown) =>
    providers.upsert(request),
  );
  handle("crewon:providers:model-catalog", (request: unknown) =>
    providerModelCatalogForForm(request, { paths, providers }),
  );
  handle("crewon:window:close", () => window.close());
  handle("crewon:window:minimize", () => window.minimize());
  handle("crewon:window:toggle-maximize", () =>
    window.isMaximized() ? window.unmaximize() : window.maximize(),
  );
  handle("crewon:window:is-maximized", () => window.isMaximized());
  handle("crewon:window:is-fullscreen", () => window.isFullScreen());
  handle("crewon:browser:create", (id: string, url: string, bounds: unknown) =>
    browserViews.create(id, url, bounds),
  );
  handle("crewon:browser:update-bounds", (id: string, bounds: unknown) =>
    browserViews.updateBounds(id, bounds),
  );
  handle("crewon:browser:set-visible", (id: string, visible: boolean) =>
    browserViews.setVisible(id, visible),
  );
  handle("crewon:browser:destroy", (id: string) => browserViews.destroy(id));
  handle("crewon:external:open", (url: string) => openExternal(url));
  registerUpdater(window, handle);
}

function registerUpdater(
  window: BrowserWindow,
  handle: <T extends unknown[]>(
    channel: string,
    listener: (...args: T) => unknown,
  ) => void,
): void {
  autoUpdater.autoDownload = false;
  let lastTransferred = 0;
  autoUpdater.on("download-progress", (progress) => {
    const started: DesktopUpdateProgress = {
      event: "Started",
      data: { contentLength: progress.total || undefined },
    };
    if (lastTransferred === 0)
      window.webContents.send("crewon:updater:progress", started);
    const current: DesktopUpdateProgress = {
      event: "Progress",
      data: {
        chunkLength: Math.max(0, progress.transferred - lastTransferred),
      },
    };
    lastTransferred = progress.transferred;
    window.webContents.send("crewon:updater:progress", current);
  });
  autoUpdater.on("update-downloaded", () => {
    window.webContents.send("crewon:updater:progress", {
      event: "Finished",
    } satisfies DesktopUpdateProgress);
  });
  handle("crewon:updater:check", async () => {
    if (!app.isPackaged) return null;
    const result = await autoUpdater.checkForUpdates();
    return result?.updateInfo
      ? {
          version: result.updateInfo.version,
          notes: releaseNotes(result.updateInfo.releaseNotes),
        }
      : null;
  });
  handle("crewon:updater:download", async () => {
    lastTransferred = 0;
    await autoUpdater.downloadUpdate();
  });
  handle("crewon:updater:relaunch", () => autoUpdater.quitAndInstall());
}

function requireMainRenderer(
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
): void {
  if (
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error("desktop_ipc_sender_invalid");
  }
}

function releaseNotes(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((entry) => entry?.note)
      .filter(Boolean)
      .join("\n");
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function desktopLog(message: string): void {
  if (!app.isPackaged)
    processRuntimeLogs().write("stdout", "CrewON desktop", `${message}\n`);
}
