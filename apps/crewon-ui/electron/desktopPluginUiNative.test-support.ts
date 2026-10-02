/** Executed by the actual pinned Electron binary, bundled only for the native integration test. */
import {
  app,
  protocol,
  BrowserWindow,
  WebContentsView,
  ipcMain,
} from "electron";
import { readFile } from "node:fs/promises";
import { DesktopPluginUiAssetBroker } from "./desktopPluginUiAssets.ts";
import {
  bindDesktopPluginUiProtocol,
  bindDesktopPluginUiIpc,
} from "./desktopPluginUiProtocol.ts";

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
void app
  .whenReady()
  .then(async () => {
    const config = JSON.parse(await readFile(process.argv[2], "utf8"));
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: config.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    let generation = 1;
    const broker = new DesktopPluginUiAssetBroker({
      session: () => ({ ...config.session, generation }),
    });
    const gates: unknown[] = [];
    const webRequest = window.webContents.session.webRequest;
    const register = webRequest.onBeforeRequest.bind(webRequest);
    // Observe the actual production listener's decision; neither its details nor its authority are fabricated.
    webRequest.onBeforeRequest = ((listener: unknown) => {
      register((details, callback) => {
        (
          listener as (
            details: Electron.OnBeforeRequestListenerDetails,
            callback: (result: { cancel?: boolean }) => void,
          ) => void
        )(details, (result: { cancel?: boolean }) => {
          if (details.url.startsWith("crewon-plugin:"))
            gates.push({
              url: details.url,
              id: details.webContentsId,
              main: details.frame === window.webContents.mainFrame,
              cancel: result.cancel === true,
            });
          callback(result);
        });
      });
    }) as typeof webRequest.onBeforeRequest;
    bindDesktopPluginUiProtocol(window, broker, () => {});
    bindDesktopPluginUiIpc(window, broker, ipcMain);
    await window.loadFile(config.document);
    const binding = await window.webContents.executeJavaScript(
      `window.crewonDesktop.pluginUiAssets.adopt(${JSON.stringify({ lease: config.lease, expectedControlOrigin: new URL(config.session.baseUrl).origin })})`,
    );
    const mounted = await window.webContents.executeJavaScript(
      `import(${JSON.stringify(binding.entryUrl)}).then(m=>{const root=document.getElementById('plugin-root');const instance=m.default.mount(root);window.nativeTestDispose=()=>instance.dispose();return {pluginId:m.default.pluginId,text:root.textContent,node:typeof require,process:typeof process}})`,
    );
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    window.contentView.addChildView(view);
    await view.webContents.loadURL(config.session.baseUrl + "native-probe");
    const viewResult = await view.webContents.executeJavaScript(
      `fetch(${JSON.stringify(binding.entryUrl)}).then(()=>true,()=>false)`,
    );
    const foreign = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: config.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    await foreign.loadFile(config.document);
    const foreignResult = await foreign.webContents.executeJavaScript(
      `import(${JSON.stringify(binding.entryUrl)}).then(()=>true,()=>false)`,
    );
    const foreignIpc = await foreign.webContents.executeJavaScript(
      `window.crewonDesktop.pluginUiAssets.adopt(${JSON.stringify({ lease: config.lease, expectedControlOrigin: new URL(config.session.baseUrl).origin })}).then(()=>true,()=>false)`,
    );
    await window.webContents.executeJavaScript(
      `new Promise(r=>{let f=document.createElement('iframe');f.onload=()=>r();f.src=${JSON.stringify(config.session.baseUrl + "native-probe")};document.body.append(f)})`,
    );
    const child = window.webContents.mainFrame.framesInSubtree.find(
      (v) => v.parent === window.webContents.mainFrame,
    )!;
    const childResult = await child.executeJavaScript(
      `fetch(${JSON.stringify(binding.entryUrl)}).then(()=>true,()=>false)`,
    );
    generation++;
    const reboundResult = await window.webContents.executeJavaScript(
      `fetch(${JSON.stringify(binding.entryUrl)}, {cache:'no-store'}).then(()=>true,()=>false)`,
    );
    await window.webContents.executeJavaScript("window.nativeTestDispose()");
    await window.webContents.executeJavaScript(
      `window.crewonDesktop.pluginUiAssets.release(${JSON.stringify(binding.bindingRef)})`,
    );
    await broker.close();
    console.log(
      "CREWON_NATIVE_PLUGIN_PROOF:" +
        JSON.stringify({
          electron: process.versions.electron,
          mounted,
          viewResult,
          foreignResult,
          foreignIpc,
          childResult,
          reboundResult,
          gates,
          usage: broker.usage,
        }),
    );
    view.webContents.close();
    foreign.destroy();
    window.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error("CREWON_NATIVE_PLUGIN_FAILURE:" + String(error));
    app.exit(1);
  });
