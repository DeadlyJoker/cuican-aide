import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
} from "electron";
import electronUpdater from "electron-updater";

import type {
  DesktopHttpRequest,
  DesktopHttpResponse,
  DesktopUpdateProgress,
} from "../src/lib/desktop/desktopBridge.ts";
import { BrowserViewManager, openExternal } from "./browserViews.ts";
import {
  LocalWorkspaceAuthority,
  LocalWorkspaceSandbox,
} from "./localWorkspace.ts";
import { loadLocalEnvironment } from "./localEnvironment.ts";
import { ProviderCredentialStore } from "./providerCredentials.ts";
import { RuntimeSupervisor, runtimePaths } from "./runtimeSupervisor.ts";

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
      process.stderr.write(`CrewON desktop failed: ${errorMessage(error)}\n`);
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
  const authority = new LocalWorkspaceAuthority(
    runtimeDataDirectory,
    process.env.CREWON_DESKTOP_WORKSPACE_ROOT?.trim() ||
      repositoryRoot ||
      undefined,
  );
  const sandbox = new LocalWorkspaceSandbox(authority);
  let runtime: RuntimeSupervisor | null = null;
  const providers = new ProviderCredentialStore(
    runtimeDataDirectory,
    async () => {
      await runtime?.restart();
    },
  );
  runtime = new RuntimeSupervisor({
    dataDirectory: runtimeDataDirectory,
    paths: runtimePaths({
      packaged: app.isPackaged,
      repositoryRoot: repositoryRoot ?? process.resourcesPath,
      resourcesPath: process.resourcesPath,
    }),
    repositoryRoot,
    provider: () => providers.active(),
    workspaceRoot: () => {
      try {
        return authority.root();
      } catch {
        return null;
      }
    },
  });
  desktopLog(`provider=${providers.active()?.providerId ?? "unconfigured"}`);
  await runtime.start().catch((error) => {
    process.stderr.write(
      `CrewON runtime unavailable: ${errorMessage(error)}\n`,
    );
  });

  const window = createWindow();
  desktopLog("window created");
  const browserViews = new BrowserViewManager(window);
  registerIpc({ authority, browserViews, providers, runtime, sandbox, window });
  await loadRenderer(window);
  desktopLog("renderer loaded");

  window.on("closed", () => browserViews.destroyAll());
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0)
      void loadRenderer(createWindow());
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => void runtime?.stop());
  app.on("second-instance", () => {
    if (window.isMinimized()) window.restore();
    window.focus();
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    frame: false,
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
  authority: LocalWorkspaceAuthority;
  browserViews: BrowserViewManager;
  providers: ProviderCredentialStore;
  runtime: RuntimeSupervisor;
  sandbox: LocalWorkspaceSandbox;
  window: BrowserWindow;
}): void {
  const { authority, browserViews, providers, runtime, sandbox, window } =
    options;
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
  handle("crewon:runtime:reload-provider", () => runtime.restart());
  handle("crewon:http:fetch", (request: DesktopHttpRequest) =>
    desktopFetch(request),
  );
  handle("crewon:sandbox:list-directory", (path?: string) =>
    sandbox.listDirectory(path),
  );
  handle("crewon:sandbox:read-file", (path: string) => sandbox.readFile(path));
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
      title: "选择本地工作区",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths[0] === undefined)
      return authority.canceled(request);
    const response = authority.select(result.filePaths[0], request);
    await runtime.restart();
    return response;
  });
  handle("crewon:workspace:clear", async (request: unknown) => {
    const response = authority.clear(request);
    await runtime.restart();
    return response;
  });
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

async function desktopFetch(
  request: DesktopHttpRequest,
): Promise<DesktopHttpResponse> {
  if (
    typeof request !== "object" ||
    request === null ||
    typeof request.url !== "string" ||
    typeof request.method !== "string" ||
    !Array.isArray(request.headers) ||
    !(request.body === null || request.body instanceof Uint8Array)
  ) {
    throw new Error("desktop_http_request_invalid");
  }
  const url = new URL(request.url);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !loopback) {
    throw new Error("desktop_http_url_invalid");
  }
  const requestBody =
    request.body === null
      ? undefined
      : (request.body.buffer.slice(
          request.body.byteOffset,
          request.body.byteOffset + request.body.byteLength,
        ) as ArrayBuffer);
  const response = await fetch(url, {
    method: request.method,
    headers: new Headers(request.headers as [string, string][]),
    body: requestBody,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > 64 * 1024 * 1024)
    throw new Error("desktop_http_response_too_large");
  return {
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    body,
  };
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
  if (!app.isPackaged) process.stdout.write(`[CrewON desktop] ${message}\n`);
}
