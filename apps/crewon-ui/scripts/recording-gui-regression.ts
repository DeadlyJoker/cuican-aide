/** Real Electron GUI regression; only the synthetic website and OS save destinations are fixtures. */
import { app, BrowserWindow, dialog } from "electron";
import { startRecordingFixtureSite } from "./recording-fixture-site.ts";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { RecordingHost } from "../electron/recordingHost.ts";
import { validateRecordingExport } from "@crewon/contracts/recording";
async function main() {
  const root = resolve(process.env.F02_REPO_ROOT!);
  const output = resolve(root, "artifacts/f02-recording");
  await mkdir(output, { recursive: true });
  await rm(join(output, "evidence"), { recursive: true, force: true });
  const data = await mkdtemp(join(tmpdir(), "crewon-recording-gui-"));
  app.setPath("userData", data);
  const { server, url } = await startRecordingFixtureSite({ port: 0 });
  await app.whenReady();
  const owner = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const host = new RecordingHost({
    ownerWindow: owner,
    directory: join(data, "recordings"),
    moduleDirectory: join(root, "apps/crewon-ui/dist-electron"),
  });
  await host.open();
  const teaching = BrowserWindow.getAllWindows().find((w) => w !== owner)!;
  const evalUi = <T = unknown>(code: string) =>
    teaching.webContents.executeJavaScript(code) as Promise<T>;
  const delay = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(check: () => Promise<boolean>, label: string) {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await delay(100);
    }
    throw new Error(`timeout: ${label}`);
  }
  async function button(text: string) {
    await evalUi(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)})?.click()`,
    );
    await delay(120);
  }
  async function fillUi(selector: string, value: string) {
    await evalUi(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await delay(50);
  }
  const state = () =>
    evalUi<import("../src/lib/desktop/recordingBridge.ts").RecordingState>(
      "window.crewonRecording.state()",
    );
  try {
    await until(
      () => evalUi(`!!document.querySelector('.recording-workspace')`),
      "teaching UI",
    );
    await fillUi('input[type="url"]', url);
    await button("开始录制");
    await until(
      async () =>
        Boolean(
          host.getExecutionSession()?.webContents.getURL().includes("/orders"),
        ),
      "page open",
    );
    const page = host.getExecutionSession()!.webContents;
    page.on("preload-error", (_e, _path, error) =>
      console.error("PRELOAD", error),
    );
    teaching.show();
    teaching.focus();
    page.focus();
    console.log(
      "PAGE_READY",
      await page.executeJavaScript(
        "JSON.stringify({focus:document.hasFocus(),ready:document.readyState})",
      ),
    );

    // Built from F05 commit 790105fd0 (or the integrated production files).
    // This test owns no CDP transport or general action implementation.
    const { BrowserViewAutomation } = await import(
      pathToFileURL(
        join(root, "apps/crewon-ui/dist-electron/recording-test-driver.mjs"),
      ).href
    );
    const automation = new BrowserViewAutomation(
      page,
      await readFile(
        join(root, "apps/crewon-ui/dist-electron/recording-test-inspection.js"),
        "utf8",
      ),
      () => {},
    );
    const focusEmulated = true; // F05 enables official focus emulation for each action and restores it in finally.
    async function act(
      action: "click" | "fill" | "select",
      name: string,
      value?: string,
    ) {
      const observation = await automation.observe();
      const target = observation.targets.find(
        (t: { name: string }) => t.name === name,
      );
      assert(target, `missing driver target: ${name}`);
      await automation.act(
        {
          action,
          target: { role: target.role, name: target.name },
          ...(value === undefined ? {} : { value }),
        },
        target.targetId,
        new AbortController().signal,
        () => {},
      );
      await delay(200);
    }
    const click = (name: string) => act("click", name);
    // Sensitive controls are deliberately absent from F05's action surface. These
    // exact synthetic fields exercise F02 exclusion via native input, never model JS.
    async function nativeFill(selector: string, value: string) {
      await page.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
        enabled: true,
      });
      try {
        const rect = await page.executeJavaScript(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
        );
        await page.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          clickCount: 1,
          ...rect,
        });
        await page.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: "left",
          clickCount: 1,
          ...rect,
        });
        await page.debugger.sendCommand("Input.insertText", { text: value });
      } finally {
        await page.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
          enabled: false,
        });
      }
    }

    await until(
      async () =>
        Boolean(
          (await state()).recording?.steps.length &&
            (await state()).captureReady,
        ),
      "navigation step and capture handshake",
    );
    await delay(150);
    await click("查看说明");
    await delay(300);
    await act("fill", "备注", "monthly report");
    await click("筛选订单");
    await until(
      async () =>
        Boolean(
          (await state()).recording?.steps.some((s) => s.kind === "input"),
        ),
      "ordinary input",
    );
    // Keyboard changes select in the actual page and generates trusted change events.
    await act("select", "渠道", "渠道");
    // Puppeteer select emits a synthetic change which F02 correctly ignores.
    // Exercise trusted native select changes separately; this is automated input.
    await click("渠道");
    await page.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
      enabled: true,
    });
    try {
      for (const [key, code] of [
        ["ArrowUp", 38],
        ["ArrowDown", 40],
      ] as const) {
        await page.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: "keyDown",
          key,
          code: key,
          windowsVirtualKeyCode: code,
        });
        await page.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: "keyUp",
          key,
          code: key,
          windowsVirtualKeyCode: code,
        });
      }
    } finally {
      await page.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
        enabled: false,
      });
    }
    await click("筛选订单");
    await button("暂停");
    await until(
      async () => (await state()).recording?.status === "paused",
      "pause",
    );
    const paused = (await state()).recording!;
    await click("筛选订单");
    await delay(200);
    assert.equal((await state()).recording!.steps.length, paused.steps.length);
    await button("继续");
    await until(
      async () => (await state()).recording?.status === "recording",
      "resume",
    );
    await click("筛选订单");
    page.session.once("will-download", (_event, item) =>
      item.setSavePath(join(output, "orders.csv")),
    );
    await click("下载 CSV");
    await until(
      async () =>
        Boolean(
          (await state()).recording?.steps.some(
            (s) => s.kind === "download" && s.outcome === "completed",
          ),
        ),
      "download",
    );
    await page.executeJavaScript("document.querySelector('details').open=true");
    await nativeFill("#password", "DO_NOT_EXPORT_PASSWORD");
    await nativeFill("#api-token", "DO_NOT_EXPORT_TOKEN");
    await click("筛选订单");
    await until(
      async () =>
        Boolean(
          (await state()).recording?.steps.some(
            (s) => s.input?.classification === "runtime-required",
          ),
        ),
      "sensitive redaction",
    );
    await page.executeJavaScript(
      "document.querySelector('details').open=false",
    );
    await button("暂停");
    await delay(1200);
    const before = (await state()).recording!;
    const deleteId = before.steps.find((s) => s.kind === "click")!.stepId;
    await evalUi(
      `document.querySelector('button[aria-label="删去第 ${before.steps.find((s) => s.stepId === deleteId)!.sequence} 步"]').click()`,
    );
    await until(
      async () =>
        !(await state()).recording!.steps.some((s) => s.stepId === deleteId),
      "delete step",
    );
    await fillUi('input[aria-label="第 1 步说明"]', "每月按渠道筛选后导出");
    await evalUi(
      `document.querySelector('input[aria-label="第 1 步说明"]').closest('form').requestSubmit()`,
    );
    await until(
      async () =>
        (await state()).recording?.steps[0]?.note === "每月按渠道筛选后导出",
      "annotation",
    );
    await button("结束录制");
    await delay(1200);
    const screenshot = await teaching.webContents.capturePage();
    await writeFile(join(output, "recording-desktop.png"), screenshot.toPNG());
    await writeFile(
      join(output, "teaching-page.png"),
      (await page.capturePage()).toPNG(),
    );
    const saved = (await state()).recording!;
    assert.equal(saved.status, "completed");
    assert(saved.edits.some((e) => e.operation === "delete"));
    assert(
      saved.steps.some(
        (s) => s.kind === "download" && s.outcome === "completed",
      ),
    );
    assert(saved.steps.some((s) => s.kind === "select"));
    assert(saved.evidence.some((e) => e.kind === "redacted-screenshot"));
    const downloadStep = saved.steps.find((s) => s.kind === "download")!;
    assert.equal(
      saved.steps.find((s) => s.stepId === downloadStep.relatedStepId)?.target
        ?.accessibleName,
      "下载 CSV",
    );
    const evidenceDirectory = join(output, "evidence");
    await mkdir(evidenceDirectory, { recursive: true });
    for (const entry of saved.evidence) {
      const uri = await evalUi<string>(
        `window.crewonRecording.evidence(${JSON.stringify(entry.evidenceId)})`,
      );
      const bytes = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
      assert.equal(bytes.byteLength, entry.byteLength);
      assert.equal(
        `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        entry.contentDigest,
      );
      await writeFile(
        join(
          evidenceDirectory,
          `${entry.evidenceId}.${entry.mediaType === "image/png" ? "png" : "svg"}`,
        ),
        bytes,
      );
    }
    const serialized = JSON.stringify(saved);
    for (const secret of [
      "DO_NOT_EXPORT_PASSWORD",
      "DO_NOT_EXPORT_TOKEN",
      "DO_NOT_EXPORT_QUERY",
    ])
      assert(!serialized.includes(secret));
    await validateRecordingExport(saved);
    const exportPath = join(output, "recording-export.json");
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: exportPath,
    })) as typeof dialog.showSaveDialog;
    await button("导出 JSON");
    await until(async () => {
      try {
        return (await readFile(exportPath, "utf8")).length > 0;
      } catch {
        return false;
      }
    }, "structured export");
    assert.equal(
      (
        await validateRecordingExport(
          JSON.parse(await readFile(exportPath, "utf8")),
        )
      ).contentDigest,
      saved.contentDigest,
    );
    const layouts = [];
    for (const [width, height] of [
      [1180, 820],
      [680, 560],
      [1024, 560],
    ]) {
      teaching.setContentSize(width!, height!);
      await delay(400);
      const measured = await evalUi<{
        width: number;
        height: number;
        scrollWidth: number;
        footerBottom: number;
        viewHeight: number;
        reviewHeight: number;
      }>(
        `(()=>{const box=s=>document.querySelector(s).getBoundingClientRect();return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,footerBottom:box('.recording-footer').bottom,viewHeight:box('.recording-viewport').height,reviewHeight:box('.recording-review').height};})()`,
      );
      assert(
        measured.scrollWidth <= measured.width,
        "horizontal viewport overflow",
      );
      assert(measured.footerBottom <= measured.height + 1, "footer clipped");
      assert(
        measured.viewHeight >= 100 && measured.reviewHeight >= 150,
        "page or review unavailable",
      );
      layouts.push(measured);
      await writeFile(
        join(output, `controller-${width}x${height}.png`),
        (await teaching.webContents.capturePage()).toPNG(),
      );
    }
    // Re-open interrupted session from a new store instance is covered by process regression separately.
    await writeFile(
      join(output, "gui-result.json"),
      JSON.stringify(
        {
          status: "passed",
          source: "real-electron-synthetic-site",
          focusEmulated,
          osSavePicker: "fixture",
          driver:
            "F05 BrowserViewAutomation / Puppeteer public ExtensionTransport",
          inputEvidence:
            "automation; sensitive-field negatives use synthetic native CDP input; no manual input claim",
          layouts,
          steps: saved.steps.length,
          evidence: saved.evidence.map((e) => ({
            kind: e.kind,
            byteLength: e.byteLength,
          })),
          revision: saved.revision,
          checks: [
            "ordinary input",
            "select/filter",
            "pause excludes events",
            "sensitive input omitted",
            "download completed",
            "delete revision",
            "annotation",
            "safe PNG evidence bytes and digests",
            "download linked to triggering click",
            "narrow and low-height layouts",
            "C01 digest",
            "export file",
          ],
          dataDirectory: data,
        },
        null,
        2,
      ),
    );
    await automation.close();
    await rm(join(output, "recording-failure.png"), { force: true });
    console.log(`F02_GUI_PASS ${output}`);
    if (process.env.F02_KEEP_OPEN === "1") await new Promise(() => {});
  } catch (error) {
    console.error(error);
    console.error("STATE", JSON.stringify(await state().catch(() => null)));
    await writeFile(
      join(output, "recording-failure.png"),
      (await teaching.webContents.capturePage()).toPNG(),
    );
    process.exitCode = 1;
  } finally {
    server.close();
    teaching.destroy();
    owner.destroy();
    app.quit();
  }
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
