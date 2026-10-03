import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join, dirname } from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  type IpcMainInvokeEvent,
} from "electron";
import { RuntimeSupervisor, runtimePaths } from "./runtimeSupervisor.ts";
import { DesktopPluginUiAssetBroker } from "./desktopPluginUiAssets.ts";
import {
  bindDesktopPluginUiIpc,
  bindDesktopPluginUiProtocol,
} from "./desktopPluginUiProtocol.ts";
import { DesktopHttpTransport } from "./desktopHttp.ts";
import { desktopHttpReply } from "./desktopHttpReply.ts";
import { bindDesktopHttpLifetime } from "./desktopHttpLifetime.ts";
import type { DesktopHttpRequest } from "../src/lib/desktop/desktopBridge.ts";

app.setPath("userData", join(dirname(process.argv[2]), "electron-user-data"));
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
let supervisor: RuntimeSupervisor | null = null;
let broker: DesktopPluginUiAssetBroker | null = null;
let window: BrowserWindow | null = null;
let off: (() => void) | null = null;
const requests: { method: string; path: string; body: unknown }[] = [];
const diagnostics: string[] = [];

async function actualDatabase(dataDirectory: string) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dataDirectory, "control.sqlite"), {
    readOnly: true,
  });
  try {
    const profile = JSON.parse(
      readFileSync(join(dataDirectory, "plugin-profile.json"), "utf8"),
    );
    const selection = db
      .prepare(
        "SELECT record_json FROM plugin_profile_selections WHERE plugin_id = ?",
      )
      .get("crewon.short-drama");
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((item) => item.name);
    const executionRows = Object.fromEntries(
      tables
        .filter((name) =>
          /(?:^run_|credit|quote|charge|^agent_version|^active_agent_version)/u.test(
            name,
          ),
        )
        .map((name) => [
          name,
          db
            .prepare(
              `SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`,
            )
            .get()!.n,
        ]),
    );
    return { profile, selection, executionRows };
  } finally {
    db.close();
  }
}
async function evaluate<T>(code: string): Promise<T> {
  return window!.webContents.executeJavaScript(code) as Promise<T>;
}
async function waitFor(code: string, label: string): Promise<void> {
  const expires = Date.now() + 20000;
  while (!(await evaluate<boolean>(code))) {
    const error = await evaluate<string | undefined>(
      "document.body.dataset.error",
    );
    assert.equal(
      error,
      undefined,
      `actual renderer bootstrap failed: ${error}`,
    );
    assert.ok(
      Date.now() < expires,
      `actual Native component timeout: ${label}; diagnostics=${JSON.stringify(diagnostics)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function click(label: string, selector = "#actual-plugin-settings") {
  const escaped = JSON.stringify(label),
    scope = JSON.stringify(selector);
  await waitFor(
    `Array.from(document.querySelector(${scope}).querySelectorAll('button')).some(b=>!b.disabled&&(b.getAttribute('aria-label')===${escaped}||b.textContent===${escaped}))`,
    `button ${label}`,
  );
  await evaluate(
    `Array.from(document.querySelector(${scope}).querySelectorAll('button')).find(b=>b.getAttribute('aria-label')===${escaped}||b.textContent===${escaped}).click()`,
  );
}

void app
  .whenReady()
  .then(async () => {
    const config = JSON.parse(readFileSync(process.argv[2], "utf8")) as {
      dataDirectory: string;
      repositoryRoot: string;
      runtimeDirectory: string | null;
      document: string;
      preload: string;
      missingTasksMarker: string;
      ownedChildrenPath: string;
    };
    supervisor = new RuntimeSupervisor({
      dataDirectory: config.dataDirectory,
      repositoryRoot: config.repositoryRoot,
      paths: runtimePaths({
        packaged: config.runtimeDirectory !== null,
        repositoryRoot: config.repositoryRoot,
        resourcesPath: config.runtimeDirectory
          ? dirname(config.runtimeDirectory)
          : config.repositoryRoot,
      }),
      agentPlatformApiKeyForOrigin: () => null,
      provider: () => null,
      providerModelCatalog: async () => {
        throw new Error("model_catalog_must_not_be_called_for_management");
      },
      workspaceRoot: () => null,
      logOutputs: { stdout: process.stdout, stderr: process.stderr },
    });
    const ownedChildren = new Set<number>();
    const trackOwnedChildren = setInterval(() => {
      try {
        const pid = supervisor!.currentControlOwner().pid;
        if (pid && !ownedChildren.has(pid)) {
          ownedChildren.add(pid);
          writeFileSync(
            config.ownedChildrenPath,
            JSON.stringify([...ownedChildren]),
          );
        }
      } catch {
        /* Startup has not assigned a genuine Control yet. */
      }
    }, 50);
    trackOwnedChildren.unref();
    await supervisor.start();
    console.log("NATIVE_MANAGEMENT_STAGE:actual_control_started");
    const session = supervisor.session();
    const live = await fetch(new URL("/api/v1/health/live", session.baseUrl));
    const ready = await fetch(new URL("/api/v1/health/ready", session.baseUrl));
    assert.equal(live.status, 200);
    assert.equal(ready.status, 503);
    const control = supervisor.currentControlOwner();
    broker = new DesktopPluginUiAssetBroker({
      session: () => ({
        ...supervisor!.session(),
        generation: supervisor!.sessionGeneration,
      }),
      controlOwner: () => supervisor!.currentControlOwner(),
      onDiagnostic: (code) => diagnostics.push(code),
    });
    off = supervisor.onSessionInvalidated(() => broker!.invalidate());
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: config.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    bindDesktopPluginUiProtocol(window, broker, (code) =>
      diagnostics.push(code),
    );
    bindDesktopPluginUiIpc(window, broker, ipcMain);
    const http = new DesktopHttpTransport();
    const handle = (
      channel: string,
      operation: (...args: unknown[]) => unknown,
    ) => {
      ipcMain.handle(
        channel,
        (event: IpcMainInvokeEvent, ...args: unknown[]) => {
          assert.equal(event.sender, window!.webContents);
          assert.equal(event.senderFrame, window!.webContents.mainFrame);
          return operation(...args);
        },
      );
    };
    handle("crewon:runtime:bootstrap", () => supervisor!.session());
    handle("crewon:http:open-v2", (input) =>
      desktopHttpReply(() => {
        const request = input as DesktopHttpRequest;
        requests.push({
          method: request.method,
          path: new URL(request.url).pathname,
          body: request.body
            ? JSON.parse(Buffer.from(request.body).toString("utf8"))
            : null,
        });
        return http.fetch(request);
      }),
    );
    handle("crewon:http:read-v2", (id) =>
      desktopHttpReply(() => http.read(id as string)),
    );
    handle("crewon:http:abort-v2", (id) =>
      desktopHttpReply(() => http.abort(id as string)),
    );
    bindDesktopHttpLifetime(window.webContents, http);
    await window.loadFile(config.document);
    console.log("NATIVE_MANAGEMENT_STAGE:actual_file_renderer_loaded");
    await waitFor(
      "document.querySelector('#actual-plugin-settings')?.textContent.includes('可安装')",
      "formal settings sources",
    );
    const missingTasks = await evaluate<{
      status: number;
      code: string;
      state: string;
    }>(
      `(async()=>{const c=window.nativePluginManagement.client.plugins;const s=(await c.listSources()).sources.find(s=>s.pluginId==='test.native-tasks');const installed=await c.installPackage({sourceId:s.sourceId,expectedPluginId:s.pluginId,expectedPackageDigest:s.packageDigest,expectedSelectionRevision:null},'actual-native-missing-tasks-install');let error;try{await c.setSelection(s.pluginId,{state:'enabled',selectedPackageDigest:s.packageDigest,expectedSelectionRevision:installed.selection.revision},'actual-native-missing-tasks-enable');error={status:200,code:'unexpected'};}catch(e){error={status:e.status,code:e.code};}return {...error,state:(await c.getSelection(s.pluginId)).selection.state};})()`,
    );
    assert.deepEqual(missingTasks, {
      status: 409,
      code: "plugin_dependency_unavailable",
      state: "disabled",
    });
    assert.equal(existsSync(config.missingTasksMarker), false);
    await click("安装 AI 短剧工作台 1.0.0");
    await waitFor(
      "document.querySelector('#actual-plugin-settings').textContent.includes('已停用')",
      "initial disabled installation",
    );
    assert.equal(
      await evaluate<number>("window.nativePluginManagement.moduleCount"),
      0,
    );
    await click("启用");
    await waitFor(
      "document.querySelector('#actual-plugin-directory').textContent.includes('AI 短剧')",
      "current installed directory",
    );
    await click("AI 短剧", "#actual-plugin-directory");
    await waitFor(
      "document.querySelector('#actual-installed-module .project-card')!==null",
      "actual installed short drama UI",
    );
    await waitFor(
      "document.querySelector('#actual-installed-module img')?.naturalWidth>0",
      "relative actual PNG bytes",
    );
    const firstImage = await evaluate<string>(
      "document.querySelector('#actual-installed-module img').src",
    );
    assert.match(firstImage, /^crewon-plugin:\/\/ui\//u);
    assert.equal(
      await evaluate<boolean>(
        `window.nativePluginManagement.assetFetch(${JSON.stringify(firstImage)},{cache:'no-store'}).then(r=>r.ok,()=>false)`,
      ),
      true,
      "the actual browser protocol can read this same current asset URL",
    );
    console.log("NATIVE_MANAGEMENT_STAGE:actual_package_ui_and_png_mounted");
    const first = await actualDatabase(config.dataDirectory);
    const oldScope = first.profile.scope;
    const oldSession = supervisor.sessionGeneration;
    const oldAssetUsage = broker.usage;
    assert.equal(oldAssetUsage.bindings, 1);
    const mountRequest = requests.find(
      (request) =>
        request.path === "/api/v1/plugins/ui/mounts" &&
        request.method === "POST",
    );
    assert.ok(mountRequest);
    const mountRef = (
      await evaluate<{
        plugins: {
          packageDigest: string;
          selectionRevision: number;
          descriptor: { pluginId: string; contributions: { id: string }[] };
        }[];
      }>("window.nativePluginManagement.client.plugins.uiCatalog()")
    ).plugins[0];
    const taskDenied = await evaluate<{ status: number; code: string }>(
      `(async()=>{const p=${JSON.stringify(mountRef)};const lease=await window.nativePluginManagement.client.plugins.openMount({pluginId:p.descriptor.pluginId,contributionId:p.descriptor.contributions[0].id,expectedSelectionRevision:p.selectionRevision,expectedPackageDigest:p.packageDigest});try{await window.nativePluginManagement.client.plugins.invoke(lease.mountRef,{action:'image.generate',input:{}});return {status:200,code:'unexpected'};}catch(e){return {status:e.status,code:e.code};}finally{await window.nativePluginManagement.client.plugins.closeMount(lease.mountRef);}})()`,
    );
    assert.ok(taskDenied.status === 403 || taskDenied.status === 409);
    await supervisor.restart();
    assert.ok(supervisor.sessionGeneration > oldSession);
    assert.notEqual(supervisor.currentControlOwner(), control);
    assert.equal(broker.usage.bindings, 0);
    const oldAssetAvailable = await evaluate<boolean>(
      `window.nativePluginManagement.assetFetch(${JSON.stringify(firstImage)},{cache:'no-store'}).then(r=>r.ok,()=>false)`,
    );
    assert.equal(oldAssetAvailable, false);
    const oldAssetRevoked = !oldAssetAvailable;
    const loaded = once(window.webContents, "did-finish-load");
    window.reload();
    await loaded;
    await waitFor(
      "document.querySelector('#actual-plugin-directory')?.textContent.includes('AI 短剧')",
      "cold SQLite selected UI recovery",
    );
    assert.deepEqual(
      (await actualDatabase(config.dataDirectory)).profile.scope,
      oldScope,
    );
    await click("AI 短剧", "#actual-plugin-directory");
    await waitFor(
      "document.querySelector('#actual-installed-module .project-card')!==null",
      "remount after actual restart",
    );
    await click("停用");
    await waitFor(
      "document.querySelector('#actual-plugin-directory').textContent===''&&document.querySelector('#actual-installed-module .project-card')===null",
      "immediate withdrawal and fresh empty catalog",
    );
    await waitFor(
      "window.nativePluginManagement.moduleCount===0",
      "zero directory modules",
    );
    await broker.invalidate();
    const final = await actualDatabase(config.dataDirectory);
    for (const [table, count] of Object.entries(final.executionRows))
      assert.equal(count, 0, `management did not write ${table}`);
    const installs = requests.filter(
      (request) =>
        request.method === "POST" &&
        request.path === "/api/v1/plugins/installations",
    );
    assert.equal(installs.length, 2);
    assert.deepEqual(Object.keys(installs[0].body as object).sort(), [
      "expectedPackageDigest",
      "expectedPluginId",
      "expectedSelectionRevision",
      "sourceId",
    ]);
    assert.equal(
      requests.filter(
        (request) =>
          request.path.includes("/turns") ||
          request.path.includes("/runs") ||
          request.path.includes("/quotes"),
      ).length,
      0,
    );
    console.log(
      "CREWON_NATIVE_MANAGEMENT_PROOF:" +
        JSON.stringify({
          electron: process.versions.electron,
          runtime: config.runtimeDirectory
            ? "packaged-seven-entry-build"
            : "actual-source-Control-child",
          live: live.status,
          ready: ready.status,
          scope: oldScope,
          initialDisabled: true,
          actualUiMounted: true,
          png: firstImage,
          oldAssetRevoked,
          coldScopeStable: true,
          disabledWithdrawsModule: true,
          taskDenied,
          missingTasks: { ...missingTasks, nodeLoaded: false },
          noProvider: true,
          executionRows: final.executionRows,
          installBodyFields: Object.keys(installs[0].body as object).sort(),
          usage: broker.usage,
        }),
    );
  })
  .then(async () => {
    off?.();
    await broker?.close();
    await supervisor?.stop();
    window?.destroy();
    app.exit(0);
  })
  .catch(async (error) => {
    console.error("ACTUAL_NATIVE_MANAGEMENT_FAILURE", error);
    off?.();
    await broker?.close().catch(() => {});
    await supervisor?.stop().catch(() => {});
    window?.destroy();
    app.exit(1);
  });
