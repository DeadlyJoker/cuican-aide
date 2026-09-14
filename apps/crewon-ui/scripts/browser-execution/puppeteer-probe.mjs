import { app, BrowserWindow, WebContentsView } from "electron";
import { connect, ExtensionTransport } from "puppeteer-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
app.setPath("userData", mkdtempSync(join(tmpdir(), "crewon-c05-probe-")));
app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({ show: true });
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    await view.webContents.loadURL(
      'data:text/html,<input aria-label="Date"><button onclick="document.title=\'clicked\'">Export</button>',
    );
    const wc = view.webContents;
    const listeners = new Map();
    globalThis.chrome = {
      debugger: {
        attach: async () => wc.debugger.attach("1.3"),
        detach: async () => wc.debugger.detach(),
        sendCommand: (source, method, params) =>
          wc.debugger.sendCommand(method, params, source.sessionId),
        onEvent: {
          addListener(listener) {
            const handler = (_event, method, params, sessionId) =>
              listener(
                { tabId: wc.id, sessionId: sessionId || undefined },
                method,
                params,
              );
            listeners.set(listener, handler);
            wc.debugger.on("message", handler);
          },
          removeListener(listener) {
            wc.debugger.removeListener("message", listeners.get(listener));
            listeners.delete(listener);
          },
        },
      },
    };
    const transport = await ExtensionTransport.connectTab(wc.id);
    wc.on("before-input-event", () => process.stdout.write("NATIVE_KEY\n"));
    wc.on("before-mouse-event", () => process.stdout.write("NATIVE_MOUSE\n"));
    try {
      const browser = await connect({
        transport,
        defaultViewport: null,
        protocolTimeout: 5000,
      });
      const pages = await browser.pages();
      process.stdout.write(
        JSON.stringify({ pages: pages.map((p) => p.url()) }) + "\n",
      );
      process.stdout.write(
        JSON.stringify(
          await pages[0].$eval("input", (e) => ({
            rect: e.getBoundingClientRect().toJSON(),
            visible: getComputedStyle(e).visibility,
          })),
        ) + "\n",
      );
      await pages[0].locator("input").setTimeout(5000).fill("2026-09");
      await pages[0].locator("button").setTimeout(5000).click();
      process.stdout.write(
        JSON.stringify({
          title: await pages[0].title(),
          value: await pages[0].$eval("input", (e) => e.value),
          webContentsId: wc.id,
          url: wc.getURL(),
          chromium: process.versions.chrome,
        }) + "\n",
      );
      await browser.disconnect();
    } catch (error) {
      process.stdout.write(`PROBE_FAILED ${error.message}\n`);
    }
    app.quit();
  })
  .catch((error) => {
    process.stderr.write(String(error));
    app.exit(1);
  });
