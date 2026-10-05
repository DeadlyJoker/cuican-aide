/** Test-only DOM driver. The formal Main owns the original preload, UI and runtime children. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import type { DesktopLocalPluginExecutionStatus } from "../src/lib/desktop/desktopLocalPluginExecutionSetupProtocol.ts";

type Config = Readonly<{
  main: string;
  document: string;
  userData: string;
  phase: "prepare" | "reopen";
  screenshotDirectory: string;
  pluginId: string;
  title: string;
  version: string;
  baseUrl: string;
}>;
const config = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Config;
app.setPath("userData", config.userData);
await import(config.main);
let window: BrowserWindow;
let accessGenerationBefore = 0;
let retainedReceipt: DesktopLocalPluginExecutionStatus | null = null;

async function evaluate<T>(code: string): Promise<T> {
  return window.webContents.executeJavaScript(code) as Promise<T>;
}
async function waitFor(code: string, label: string) {
  const deadline = Date.now() + 50_000;
  while (true) {
    try {
      if (await evaluate<boolean>(code)) return;
    } catch {
      /* Original document may be loading. */
    }
    if (Date.now() >= deadline) {
      const body = await evaluate<string>("document.body.innerText").catch(
        () => "document unavailable",
      );
      const settingsButtons = await evaluate<unknown>(
        "Array.from(document.querySelectorAll('.installed-plugin-settings button')).slice(0,30).map(b=>({label:b.getAttribute('aria-label'),text:b.textContent.trim().slice(0,200),disabled:b.disabled}))",
      ).catch(() => []);
      throw new Error(
        `native_execution_setup_timeout:${label}:${body.slice(0, 4500)}:settingsButtons=${JSON.stringify(settingsButtons)}`,
      );
    }
    await new Promise((accept) => setTimeout(accept, 25));
  }
}
async function click(label: string, selector: string) {
  const root = `document.querySelector(${JSON.stringify(selector)})`;
  const buttons = `Array.from(${root}?.querySelectorAll('button')??[])`;
  const match = `!b.disabled&&(b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)})`;
  await waitFor(`${buttons}.some(b=>${match})`, `button ${label}`);
  await evaluate(`${buttons}.find(b=>${match}).click()`);
}
async function capture(name: string, width = 1440, height = 900) {
  window.setSize(width, height);
  await evaluate(`(()=>{
    const panel=document.querySelector('.installed-plugin-configuration');
    const button=Array.from(panel?.querySelectorAll('button')??[]).find(b=>b.textContent.includes('允许并准备')||b.textContent.includes('预览执行准备'));
    button?.scrollIntoView({block:'center',inline:'nearest'});
  })()`);
  await evaluate(
    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
  );
  await new Promise((accept) => setTimeout(accept, 75));
  const metrics = await evaluate<{
    overflow: boolean;
    visible: boolean;
  }>(`(()=>{
    const panel=document.querySelector('.installed-plugin-configuration');
    const button=Array.from(panel?.querySelectorAll('button')??[]).find(b=>b.textContent.includes('允许并准备')||b.textContent.includes('预览执行准备'));
    const rect=button?.getBoundingClientRect();
    return {overflow:document.documentElement.scrollWidth>innerWidth,visible:!!rect&&rect.width>0&&rect.height>0&&rect.top>=0&&rect.bottom<=innerHeight&&rect.left>=0&&rect.right<=innerWidth};
  })()`);
  assert.equal(
    metrics.overflow,
    false,
    `no horizontal overflow at ${width}x${height}`,
  );
  assert.equal(
    metrics.visible,
    true,
    "setup control is reachable inside the viewport through the original panel scroll",
  );
  const image = await window.webContents.capturePage();
  assert.ok(!image.isEmpty());
  writeFileSync(join(config.screenshotDirectory, name), image.toPNG());
}
void app.whenReady().then(async () => {
  try {
    const deadline = Date.now() + 50_000;
    while (!BrowserWindow.getAllWindows()[0]) {
      assert.ok(Date.now() < deadline, "formal Main must create its window");
      await new Promise((accept) => setTimeout(accept, 25));
    }
    window = BrowserWindow.getAllWindows()[0]!;
    await waitFor(
      "document.querySelector('.sidebar-account summary')!==null",
      "original account entry",
    );
    assert.equal(
      new URL(window.webContents.getURL()).pathname,
      new URL(config.document).pathname,
    );
    assert.equal(
      await evaluate<boolean>(
        "typeof window.require==='undefined'&&typeof window.process==='undefined'&&window.crewonDesktop?.pluginExecutionSetup?.version===1",
      ),
      true,
    );
    if (config.phase === "prepare") {
      // Exercise the real owner notification before accepting a preview. A later
      // self-restart must retain this nonzero public owner epoch across App remounts.
      await evaluate("window.crewonDesktop.runtime.reloadProvider()");
      await waitFor(
        "document.querySelector('.sidebar-account summary')!==null",
        "original App after earlier owner change",
      );
    }
    const before = await evaluate<{ generation: number }>(
      "window.crewonDesktop.runtime.localManagementAccess()",
    );
    accessGenerationBefore = before.generation;
    await evaluate(
      "document.querySelector('.sidebar-account summary').click()",
    );
    await click("设置", ".sidebar-account");
    await click("工具与扩展", ".settings-sidebar");
    await waitFor(
      "document.querySelector('.installed-plugin-settings')!==null",
      "original plugin settings",
    );
    if (config.phase === "prepare")
      await click(
        `安装 ${config.title} ${config.version}`,
        '.installed-plugin-settings[aria-label="插件管理"]',
      );
    await waitFor(
      `Array.from(document.querySelectorAll('.installed-plugin-card')).some(c=>c.textContent.includes(${JSON.stringify(config.pluginId)})&&c.textContent.includes('已停用'))`,
      "installed package remains disabled",
    );
    await click(
      "业务配置",
      '.installed-plugin-settings[aria-label="插件管理"]',
    );
    await waitFor(
      "document.querySelector('.installed-plugin-configuration input[aria-label=baseUrl]')!==null",
      "original saved-parameter panel",
    );
    if (config.phase === "prepare") {
      await evaluate(`(()=>{
        const field=document.querySelector('.installed-plugin-configuration input[aria-label=baseUrl]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(config.baseUrl)});
        field.dispatchEvent(new Event('input',{bubbles:true}));
        field.dispatchEvent(new Event('change',{bubbles:true}));
      })()`);
      await evaluate(
        "document.querySelector('.installed-plugin-configuration [aria-label=preset]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
      );
      await waitFor(
        "Array.from(document.querySelectorAll('[role=option]')).some(e=>e.textContent.trim()==='krea2-portrait')",
        "explicit workflow preset choice",
      );
      await evaluate(
        "Array.from(document.querySelectorAll('[role=option]')).find(e=>e.textContent.trim()==='krea2-portrait').click()",
      );
      // The original schema renders enum input as a select trigger, never a hidden default.
      await click("保存参数", ".installed-plugin-configuration");
      await waitFor(
        "document.querySelector('.installed-plugin-configuration')?.textContent.includes('已保存版本 1')",
        "saved configuration revision",
      );
      await click("预览执行准备", ".installed-plugin-configuration");
      await waitFor(
        "document.querySelector('.installed-plugin-configuration')?.textContent.includes('保存配置版本：1')",
        "Main-issued exact preview",
      );
      assert.equal(
        await evaluate<boolean>(
          "Array.from(document.querySelectorAll('.installed-plugin-configuration button')).find(b=>b.textContent.trim()==='允许并准备')?.disabled",
        ),
        true,
      );
      await capture("execution-setup-preview-desktop.png");
      await capture("execution-setup-preview-low-height.png", 1440, 640);
      await capture("execution-setup-preview-narrow.png", 960, 640);
      await evaluate(
        "document.querySelector('.installed-plugin-configuration [role=switch]').click()",
      );
      await click("允许并准备", ".installed-plugin-configuration");
      await waitFor(
        "document.querySelector('.installed-plugin-configuration')?.textContent.includes('执行环境已准备')",
        "two original preparations and Settings remount receipt",
      );
      const receipt = await evaluate<DesktopLocalPluginExecutionStatus>(
        `window.crewonDesktop.pluginExecutionSetup.readStatus({pluginId:${JSON.stringify(config.pluginId)}})`,
      );
      assert.equal(receipt.state, "committed");
      assert.ok(receipt.state === "committed");
      retainedReceipt = receipt;
      assert.equal(receipt.result.state, "prepared");
      assert.equal(receipt.result.stage, "mappingCommitted");
      assert.equal(receipt.result.runtimeStatus, "ready");
      const after = await evaluate<{ generation: number }>(
        "window.crewonDesktop.runtime.localManagementAccess()",
      );
      assert.equal(
        after.generation - before.generation,
        2,
        "exactly two original physical restarts",
      );
      assert.ok(
        await evaluate<boolean>(
          "document.querySelector('.installed-plugin-settings[aria-label=插件管理]')?.textContent.includes('已停用')",
        ),
      );
      await capture("execution-setup-prepared.png", 1440, 900);
    } else {
      assert.equal(
        await evaluate<string>(
          "document.querySelector('.installed-plugin-configuration input[aria-label=baseUrl]').value",
        ),
        config.baseUrl,
      );
      assert.equal(
        await evaluate<unknown>(
          `window.crewonDesktop.pluginExecutionSetup.readStatus({pluginId:${JSON.stringify(config.pluginId)}})`,
        ),
        null,
        "memory receipt is not manufactured after a cold start",
      );
      await capture("execution-setup-cold-reopened.png");
    }
    assert.equal(
      await evaluate<number>(
        "document.querySelectorAll('[data-host-module-target]').length",
      ),
      0,
      "preparation never enables UI contributions",
    );
    console.log(
      "CREWON_NATIVE_EXECUTION_SETUP_PROOF:" +
        JSON.stringify({
          phase: config.phase,
          formalMain: true,
          originalSettings: true,
          isolatedPreload: true,
          disabledSelection: true,
          accessGenerationBefore,
          selfRestarts: config.phase === "prepare" ? 2 : 0,
          nativeProcessId: process.pid,
          formalDocument: window.webContents.getURL(),
          receipt: retainedReceipt,
        }),
    );
    app.quit();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
    app.quit();
  }
});
