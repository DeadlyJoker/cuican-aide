import { app, BrowserWindow, WebContentsView } from "electron";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import type { ToolExecutionCommand } from "@crewon/tool-broker";
import {
  BrowserViewAutomation,
  isBrowserAutomationInput,
} from "../../electron/browserExecutionPuppeteer.ts";
import { BrowserExecutionDownloads } from "../../electron/browserExecutionDownload.ts";

const output = resolve(
  process.env.CREWON_F05_EVIDENCE_DIR ?? "artifacts/f05-browser-execution",
);
mkdirSync(output, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), "crewon-f05-acceptance-"));
app.setPath("userData", userData);
app
  .whenReady()
  .then(async () => {
    const events: string[] = [];
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/export")) {
        response.writeHead(200, {
          "Content-Type": "text/csv",
          "Content-Disposition": 'attachment; filename="orders.csv"',
        });
        response.end("order_id,amount\nA101,110.00\nA103,90.00\n");
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html><body><h1>合成订单</h1><label>日期<input type="text" value="2026-08"></label><label>渠道<select><option value="direct">直营</option><option value="partner">渠道</option></select></label><button onclick="document.querySelector('#result').textContent=document.querySelector('input').value+' / '+document.querySelector('select').value">筛选</button><p id="result"></p><a href="/export">下载订单</a><button disabled>等待按钮</button><script>document.querySelector('input').addEventListener('input',()=>document.body.dataset.input='yes');document.querySelector('select').addEventListener('change',()=>document.body.dataset.selected='yes');</script></body></html>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("address");
    const url = `http://127.0.0.1:${address.port}/orders`;
    const window = new BrowserWindow({ width: 900, height: 650, show: true });
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: "persist:teaching-probe",
      },
    });
    window.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 900, height: 650 });
    const wc = view.webContents;
    let generation = 0;
    wc.on("did-start-navigation", (_e, _url, _same, main) => {
      if (main) generation++;
    });
    await wc.loadURL(url);
    const source = readFileSync(
      resolve("apps/crewon-ui/dist-electron/browser-execution-inspection.js"),
      "utf8",
    );
    let detached = 0;
    let automation = new BrowserViewAutomation(wc, source, () => detached++);
    let automatedInputs = 0;
    let manualInputs = 0;
    wc.on("before-mouse-event", () => {
      if (isBrowserAutomationInput(wc)) automatedInputs++;
      else manualInputs++;
    });
    const command = (executionId: string) =>
      ({
        executionId,
        runId: "synthetic-probe-run",
        actionDigest: `sha256:${"a".repeat(64)}`,
      }) as ToolExecutionCommand;
    const act = async (
      action: "click" | "fill" | "select" | "download",
      name: string,
      value?: string,
      signal = new AbortController().signal,
    ) => {
      process.stdout.write(`ACTION ${action} ${name}\n`);
      const observation = await automation.observe();
      const targets = observation.targets.filter((t) => t.name === name);
      assert.equal(targets.length, 1);
      const target = targets[0]!;
      await automation.act(
        {
          action,
          sessionId: "synthetic-probe-session",
          generation,
          observationId: "synthetic-observation",
          target: { targetId: target.targetId },
          ...(value === undefined ? {} : { value }),
        } as Parameters<BrowserViewAutomation["act"]>[0],
        target.targetId,
        signal,
        () => {
          events.push(`effect:${action}:${name}`);
          process.stdout.write(`EFFECT ${action} ${name}\n`);
        },
      );
    };
    try {
      process.stdout.write(
        JSON.stringify(
          await wc.executeJavaScript(
            "({visibility:document.visibilityState,focus:document.hasFocus(),width:innerWidth,height:innerHeight})",
          ),
        ) + "\n",
      );
      const first = await automation.observe();
      assert(first.targets.some((t) => t.name === "日期"));
      assert(Buffer.byteLength(JSON.stringify(first)) <= 8192);
      await act("fill", "日期", "2026-09");
      await act("select", "渠道", "partner");
      await act("click", "筛选");
      const state = await wc.executeJavaScript(
        "({result:document.querySelector('#result').textContent,input:document.body.dataset.input,selected:document.body.dataset.selected})",
      );
      assert.deepEqual(state, {
        result: "2026-09 / partner",
        input: "yes",
        selected: "yes",
      });
      const beforeRejectedInputs = events.length;
      await assert.rejects(
        act("select", "渠道", "missing"),
        /browser_select_option_unavailable/,
      );
      assert.equal(
        await wc.executeJavaScript("document.querySelector('select').value"),
        "partner",
      );
      await wc.executeJavaScript(
        "document.querySelector('input').readOnly=true",
      );
      await assert.rejects(
        act("fill", "日期", "must-not-fill"),
        /browser_fill_unsupported/,
      );
      assert.equal(
        await wc.executeJavaScript("document.querySelector('input').value"),
        "2026-09",
      );
      await wc.executeJavaScript(
        "document.querySelector('input').readOnly=false;const fieldset=document.createElement('fieldset');fieldset.disabled=true;const child=document.createElement('input');child.setAttribute('aria-label','禁用日期');fieldset.append(child);document.body.append(fieldset)",
      );
      await assert.rejects(
        act("fill", "禁用日期", "must-not-fill"),
        /browser_fill_unsupported/,
      );
      assert.equal(events.length, beforeRejectedInputs);
      const downloads = new BrowserExecutionDownloads(
        join(userData, "downloads"),
      );
      const receipt = await downloads.capture(
        wc,
        command("download-1"),
        new AbortController().signal,
        () => act("download", "下载订单"),
      );
      const bytes = downloads.read(receipt.receiptId, command("download-1"));
      assert(Buffer.from(bytes).toString().includes("A101,110.00"));
      assert.equal(
        await wc.executeJavaScript("document.visibilityState"),
        "hidden",
      );
      const before = await automation.observe();
      const oldTarget = before.targets.find((t) => t.name === "筛选")!;
      await wc.loadURL(`${url}?period=next`);
      await assert.rejects(
        automation.act(
          {
            action: "click",
            sessionId: "s",
            generation: generation - 1,
            observationId: "old",
            target: { targetId: oldTarget.targetId },
          },
          oldTarget.targetId,
          new AbortController().signal,
          () => events.push("stale-effect"),
        ),
      );
      assert(!events.includes("stale-effect"));
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 80);
      await assert.rejects(act("click", "等待按钮", undefined, abort.signal));
      assert(!events.includes("effect:click:等待按钮"));
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(
        await wc.executeJavaScript("document.visibilityState"),
        "hidden",
      );
      wc.debugger.detach();
      assert.equal(detached, 1);
      await automation.close();
      automation = new BrowserViewAutomation(wc, source, () => detached++);
      await act("fill", "日期", "2026-10");
      await wc
        .capturePage()
        .then((image) =>
          writeFileSync(join(output, "same-view.png"), image.toPNG()),
        );
      assert(automatedInputs > 0);
      assert.equal(manualInputs, 0);
      wc.sendInputEvent({
        type: "mouseDown",
        x: 8,
        y: 8,
        button: "left",
        clickCount: 1,
      });
      wc.sendInputEvent({
        type: "mouseUp",
        x: 8,
        y: 8,
        button: "left",
        clickCount: 1,
      });
      await new Promise((r) => setTimeout(r, 30));
      assert(manualInputs > 0);
      const evidence = {
        kind: "real-electron-synthetic-business-page",
        notCovered: [
          "F02 RecordingHost integration",
          "real model Run",
          "F01 import",
        ],
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        node: process.versions.node,
        puppeteer: "25.9.0",
        webContentsId: wc.id,
        generation,
        state,
        receipt,
        focusRestoredAfterActionAndCancel: true,
        downloadReturnedAfterFocusRestored: true,
        readonlyAndDisabledFillRejected: true,
        missingSelectOptionRejected: true,
        events,
        automatedInputs,
        manualInputs,
        detached,
      };
      writeFileSync(
        join(output, "same-view.json"),
        JSON.stringify(evidence, null, 2),
      );
      process.stdout.write(JSON.stringify(evidence) + "\n");
    } finally {
      await automation.close();
      wc.close();
      window.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      app.quit();
    }
  })
  .catch((error) => {
    process.stderr.write(String(error.stack ?? error) + "\n");
    app.exit(1);
  });
