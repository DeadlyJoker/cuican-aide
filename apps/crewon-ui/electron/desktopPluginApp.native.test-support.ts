/** Test-only entry: configure isolated app storage, then import the unchanged formal Electron Main. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

type Config = Readonly<{
  main: string;
  userData: string;
  phase: "install" | "restore";
  screenshotDirectory: string;
}>;
const config = JSON.parse(readFileSync(process.argv[2], "utf8")) as Config;
app.setPath("userData", config.userData);
const actualFetch = globalThis.fetch.bind(globalThis);
let onlinePosts = 0;
let observedHttpRequests = 0;
// Observation only: every request still uses the original physical fetch and formal HTTP handlers.
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  observedHttpRequests++;
  if (
    method === "POST" &&
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
  )
    onlinePosts++;
  return actualFetch(input, init);
};
// This grants no access. The formal Main owns every IPC, bootstrap, session and asset handler.
await import(config.main);

let window: BrowserWindow | null = null;
async function evaluate<T>(code: string): Promise<T> {
  return window!.webContents.executeJavaScript(code) as Promise<T>;
}
async function waitFor(code: string, label: string) {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      if (await evaluate<boolean>(code)) return;
    } catch {
      /* The unchanged Main may still be loading its actual file document. */
    }
    if (Date.now() >= deadline) {
      const body = await evaluate<string>("document.body.innerText").catch(
        () => "document unavailable",
      );
      throw new Error(`formal_app_timeout:${label}:${body.slice(0, 3000)}`);
    }
    await new Promise((accept) => setTimeout(accept, 20));
  }
}
async function click(label: string, selector = "document") {
  const encoded = JSON.stringify(label);
  const root =
    selector === "document"
      ? "document"
      : `document.querySelector(${JSON.stringify(selector)})`;
  await waitFor(
    `Array.from(${root}?.querySelectorAll('button')??[]).some(b=>!b.disabled&&(b.getAttribute('aria-label')===${encoded}||b.textContent.trim()===${encoded}))`,
    `button ${label}`,
  );
  await evaluate(
    `Array.from(${root}.querySelectorAll('button')).find(b=>!b.disabled&&(b.getAttribute('aria-label')===${encoded}||b.textContent.trim()===${encoded})).click()`,
  );
}
async function capture(file: string) {
  // DOM route assertions may precede Chromium's composited frame. Capture the
  // actual formal window only after the renderer has painted the new route.
  await evaluate(
    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
  );
  await new Promise((accept) => setTimeout(accept, 100));
  const image = await window!.webContents.capturePage();
  assert.ok(!image.isEmpty());
  writeFileSync(join(config.screenshotDirectory, file), image.toPNG());
}
async function settings() {
  await waitFor(
    "document.querySelector('.sidebar-account summary')!==null",
    "original account entry",
  );
  await evaluate("document.querySelector('.sidebar-account summary').click()");
  await click("设置", ".sidebar-account");
  await click("工具与扩展", ".settings-sidebar");
  await waitFor(
    "document.querySelector('.installed-plugin-settings')?.textContent.includes('可安装')",
    "formal plugin settings",
  );
}

void app
  .whenReady()
  .then(async () => {
    const deadline = Date.now() + 30_000;
    while (!BrowserWindow.getAllWindows()[0]) {
      assert.ok(
        Date.now() < deadline,
        "formal Main must create its actual BrowserWindow",
      );
      await new Promise((accept) => setTimeout(accept, 20));
    }
    window = BrowserWindow.getAllWindows()[0];
    await waitFor(
      "document.querySelector('.sidebar-account')?.textContent.includes('本机管理')",
      "actual Native access opens original App with signed-out account",
    );
    assert.ok(window.webContents.getURL().startsWith("file:"));
    assert.equal(
      await evaluate<boolean>(
        "typeof window.require==='undefined'&&typeof window.process==='undefined'&&window.crewonDesktop!==undefined",
      ),
      true,
    );
    const localAccess = await evaluate<{ generation: number } | null>(
      "window.crewonDesktop.runtime.localManagementAccess()",
    );
    assert.ok(localAccess && Number.isSafeInteger(localAccess.generation));
    // Tokens stay in memory and are never part of this test's proof or screenshots.
    const session = await evaluate<{ baseUrl: string }>(
      "window.crewonDesktop.runtime.bootstrap()",
    );
    const live = (await fetch(new URL("/api/v1/health/live", session.baseUrl)))
      .status;
    const ready = (
      await fetch(new URL("/api/v1/health/ready", session.baseUrl))
    ).status;
    assert.equal(live, 200);
    assert.equal(ready, 503);
    await capture(`formal-app-${config.phase}-account.png`);
    await evaluate(
      "document.querySelector('.sidebar-account summary').click()",
    );
    await click("登录企业账号", ".sidebar-account");
    await waitFor(
      "document.querySelector('.crewon-auth-shell input')!==null&&document.querySelector('.sidebar-account')===null",
      "original enterprise login form remains reachable",
    );
    await capture(`formal-app-${config.phase}-enterprise-login.png`);
    await click("返回本机管理", ".crewon-auth-shell");
    await waitFor(
      "document.querySelector('.sidebar-account')?.textContent.includes('本机管理')",
      "return through the genuine unchanged Native local session",
    );
    await settings();
    const settingsLabels = await evaluate<string[]>(
      "Array.from(document.querySelectorAll('.settings-sidebar strong')).map(e=>e.textContent.trim())",
    );
    for (const label of [
      "外观",
      "AI 模型",
      "工具与扩展",
      "助理与记忆",
      "常规",
      "账号",
      "安全与权限",
      "网页应用",
      "连接管理",
      "键盘快捷键",
    ]) {
      assert.ok(
        settingsLabels.includes(label),
        `original settings navigation still contains ${label}`,
      );
      await click(label, ".settings-sidebar");
      await waitFor(
        `document.querySelector('.settings-sidebar button[aria-current=page]')?.textContent.trim()===${JSON.stringify(label)}`,
        `actual existing settings route ${label}`,
      );
    }
    await click("工具与扩展", ".settings-sidebar");
    await waitFor(
      "document.querySelector('.installed-plugin-settings')?.textContent.includes('可安装')",
      "return to existing extensions settings",
    );
    if (config.phase === "install") {
      await capture("formal-app-install-settings.png");
      await click("安装 AI 短剧工作台 1.0.0", ".installed-plugin-settings");
      await waitFor(
        "document.querySelector('.installed-plugin-settings').textContent.includes('已停用')",
        "installation initially disabled",
      );
      assert.equal(
        await evaluate<number>(
          "document.querySelectorAll('[data-host-module-target]').length",
        ),
        0,
      );
      await click("启用", ".installed-plugin-settings");
      await waitFor(
        "document.querySelector('.installed-plugin-settings').textContent.includes('已启用')",
        "explicit current selection",
      );
    } else {
      await waitFor(
        "document.querySelector('.installed-plugin-settings').textContent.includes('已启用')",
        "cold actual SQLite selection remains enabled",
      );
      await waitFor(
        "document.querySelector('.installed-plugin-settings').textContent.includes('暂无可安装')",
        "missing original source is not a new install source",
      );
    }
    await click("返回", ".settings-sidebar");
    await click("AI 短剧", ".sidebar-nav");
    await waitFor(
      "document.querySelector('.project-card')!==null",
      "actual independently installed module in original App content",
    );
    await waitFor(
      "document.querySelector('.project-card img')?.naturalWidth>0",
      "actual installed PNG served through production Native protocol",
    );
    const image = await evaluate<string>(
      "document.querySelector('.project-card img').src",
    );
    assert.match(image, /^crewon-plugin:\/\/ui\//u);
    assert.equal(
      await evaluate<boolean>(
        "document.querySelector('.sidebar-account')?.textContent.includes('未登录')",
      ),
      true,
    );
    assert.equal(
      await evaluate<boolean>(
        "document.querySelector('[role=menuitem]')?.textContent.includes('退出登录')??false",
      ),
      false,
    );
    await capture(`formal-app-${config.phase}-installed-short-drama.png`);
    const profile = JSON.parse(
      readFileSync(
        join(config.userData, "control-runtime-v1", "plugin-profile.json"),
        "utf8",
      ),
    );
    console.log(
      "CREWON_FORMAL_APP_PROOF:" +
        JSON.stringify({
          electron: process.versions.electron,
          phase: config.phase,
          runtime: "actual-source-Control-child",
          formalMain: config.main,
          formalDocument: window.webContents.getURL(),
          live,
          ready,
          localAccessGeneration: localAccess.generation,
          scope: profile.scope,
          signedOutAccount: true,
          enterpriseLoginAvailable: true,
          returnedToLocalManagement: true,
          originalSettings: true,
          settingsLabels,
          actualInstalledUi: true,
          actualPng: image,
          noProvider: true,
          onlinePosts,
          observedHttpRequests,
        }),
    );
    // The formal Main's before-quit handler physically joins assets and runtime children.
    app.quit();
  })
  .catch((error) => {
    console.error("CREWON_FORMAL_APP_FAILURE", error);
    app.quit();
    // Failure exits after the same production cleanup; the outer test enforces its deadline.
    process.exitCode = 1;
  });
