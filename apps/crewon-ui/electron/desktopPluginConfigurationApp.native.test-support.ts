/** Test-only storage/DOM driver; the formal Main owns its window, preload, identity and HTTP bridge. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

type Config = Readonly<{
  main: string;
  document: string;
  userData: string;
  phase: "write" | "reopen";
  screenshotDirectory: string;
  pluginId: string;
  title: string;
  version: string;
  parameters: Readonly<{ organization: string; providerBaseUrl: string }>;
}>;
const config = JSON.parse(readFileSync(process.argv[2], "utf8")) as Config;
app.setPath("userData", config.userData);
const actualFetch = globalThis.fetch.bind(globalThis);
const configurationWrites: {
  authenticated: boolean;
  csrf: boolean;
  origin: boolean;
  idempotency: boolean;
  status: number;
}[] = [];
let configurationReads = 0;
let supplierRequests = 0;
let onlinePosts = 0;
// Observation only: request bytes, responses and authority always use the original physical fetch.
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  const isConfiguration =
    url.pathname === `/api/v1/extensions/${config.pluginId}/configuration`;
  if (isConfiguration && method === "GET") configurationReads++;
  if (url.origin === new URL(config.parameters.providerBaseUrl).origin)
    supplierRequests++;
  if (
    method === "POST" &&
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
  )
    onlinePosts++;
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const response = await actualFetch(input, init);
  if (isConfiguration && method === "PUT")
    configurationWrites.push({
      authenticated: /^Bearer .+/u.test(headers.get("authorization") ?? ""),
      csrf: Boolean(headers.get("x-csrf-token")),
      origin: Boolean(headers.get("origin")),
      idempotency: Boolean(headers.get("idempotency-key")),
      status: response.status,
    });
  return response;
};
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
      // The original Main may still be loading its actual file document.
    }
    if (Date.now() >= deadline) {
      const body = await evaluate<string>("document.body.innerText").catch(
        () => "document unavailable",
      );
      throw new Error(
        `native_configuration_timeout:${label}:${body.slice(0, 3000)}`,
      );
    }
    await new Promise((accept) => setTimeout(accept, 20));
  }
}
async function click(label: string, selector: string) {
  const value = JSON.stringify(label);
  const root = `document.querySelector(${JSON.stringify(selector)})`;
  const buttons = `Array.from(${root}?.querySelectorAll('button')??[])`;
  const matches = `!b.disabled&&(b.getAttribute('aria-label')===${value}||b.textContent.trim()===${value})`;
  await waitFor(`${buttons}.some(b=>${matches})`, `button ${label}`);
  await evaluate(`${buttons}.find(b=>${matches}).click()`);
}
async function fill(name: string, value: string) {
  const selector = `.installed-plugin-configuration input[aria-label=${JSON.stringify(name)}]`;
  await waitFor(
    `document.querySelector(${JSON.stringify(selector)})?.disabled===false`,
    `editable field ${name}`,
  );
  await evaluate(`(()=>{
    const field=document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)});
    field.dispatchEvent(new Event('input',{bubbles:true}));
    field.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
}
async function capture(file: string) {
  await evaluate(
    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
  );
  await new Promise((accept) => setTimeout(accept, 100));
  const image = await window!.webContents.capturePage();
  assert.ok(!image.isEmpty());
  writeFileSync(join(config.screenshotDirectory, file), image.toPNG());
}

void app
  .whenReady()
  .then(async () => {
    const deadline = Date.now() + 30_000;
    while (!BrowserWindow.getAllWindows()[0]) {
      assert.ok(Date.now() < deadline, "formal Main must create its window");
      await new Promise((accept) => setTimeout(accept, 20));
    }
    window = BrowserWindow.getAllWindows()[0];
    await waitFor(
      "document.querySelector('.sidebar-account')?.textContent.includes('本机管理')",
      "actual Native session opens original signed-out App",
    );
    const formalDocument = new URL(window.webContents.getURL());
    const expectedDocument = new URL(config.document);
    assert.equal(formalDocument.protocol, "file:");
    assert.equal(formalDocument.pathname, expectedDocument.pathname);
    assert.ok(expectedDocument.pathname.endsWith("/dist/index.html"));
    assert.equal(
      await evaluate<boolean>(
        "typeof window.require==='undefined'&&typeof window.process==='undefined'&&window.crewonDesktop?.version===1",
      ),
      true,
    );
    const access = await evaluate<{ generation: number } | null>(
      "window.crewonDesktop.runtime.localManagementAccess()",
    );
    assert.ok(access && Number.isSafeInteger(access.generation));
    // The real bridge supplies the session; no token or synthetic actor enters the driver configuration.
    const bootstrap = await evaluate<{ baseUrl: string }>(
      "window.crewonDesktop.runtime.bootstrap()",
    );
    const live = (
      await fetch(new URL("/api/v1/health/live", bootstrap.baseUrl))
    ).status;
    const ready = (
      await fetch(new URL("/api/v1/health/ready", bootstrap.baseUrl))
    ).status;
    assert.equal(live, 200);
    assert.equal(ready, 503);
    await evaluate(
      "document.querySelector('.sidebar-account summary').click()",
    );
    await click("设置", ".sidebar-account");
    await waitFor(
      "document.querySelector('.settings-sidebar strong')!==null",
      "original settings route has rendered",
    );
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
    ])
      assert.ok(settingsLabels.includes(label), `original settings: ${label}`);
    await click("工具与扩展", ".settings-sidebar");
    await waitFor(
      "document.querySelector('.installed-plugin-settings')?.textContent.includes('可安装')",
      "original installation settings with actual Control client",
    );
    if (config.phase === "write") {
      await click(
        `安装 ${config.title} ${config.version}`,
        ".installed-plugin-settings",
      );
    } else {
      await waitFor(
        "document.querySelector('.installed-plugin-settings')?.textContent.includes('暂无可安装')",
        "offline original source is no longer an install candidate",
      );
    }
    await waitFor(
      `Array.from(document.querySelectorAll('.installed-plugin-card')).some(card=>card.textContent.includes(${JSON.stringify(config.pluginId)})&&card.textContent.includes('已停用'))`,
      "actual selected business package stays disabled",
    );
    assert.equal(
      await evaluate<number>(
        "document.querySelectorAll('[data-host-module-target]').length",
      ),
      0,
    );
    await click("业务配置", ".installed-plugin-settings");
    await waitFor(
      "document.querySelector('.installed-plugin-configuration input[aria-label=organization]')!==null&&document.querySelector('.installed-plugin-configuration input[aria-label=providerBaseUrl]')!==null",
      "actual package business schema provides both fields",
    );
    if (config.phase === "write") {
      assert.equal(
        await evaluate<boolean>(
          "document.querySelector('.installed-plugin-configuration').textContent.includes('尚未保存参数')",
        ),
        true,
      );
      await fill("organization", config.parameters.organization);
      await fill("providerBaseUrl", config.parameters.providerBaseUrl);
      await click("保存参数", ".installed-plugin-configuration");
      await waitFor(
        "document.querySelector('.installed-plugin-configuration')?.textContent.includes('业务配置已保存；尚未发布或启用运行')",
        "original authenticated PUT committed actual configuration",
      );
    }
    await waitFor(
      `document.querySelector('.installed-plugin-configuration')?.textContent.includes('已保存版本 1')&&document.querySelector('input[aria-label=organization]')?.value===${JSON.stringify(config.parameters.organization)}&&document.querySelector('input[aria-label=providerBaseUrl]')?.value===${JSON.stringify(config.parameters.providerBaseUrl)}`,
      "latest revision and both non-secret parameters match the saved configuration",
    );
    assert.ok(
      configurationReads > 0,
      "configuration is read through physical HTTP",
    );
    assert.equal(configurationWrites.length, config.phase === "write" ? 1 : 0);
    for (const write of configurationWrites) {
      const { status, ...authorization } = write;
      assert.deepEqual(authorization, {
        authenticated: true,
        csrf: true,
        origin: true,
        idempotency: true,
      });
      assert.ok(status >= 200 && status < 300);
    }
    assert.equal(supplierRequests, 0);
    assert.equal(onlinePosts, 0);
    await capture(`native-business-configuration-${config.phase}.png`);
    const profile = JSON.parse(
      readFileSync(
        join(config.userData, "control-runtime-v1", "plugin-profile.json"),
        "utf8",
      ),
    );
    const providerCredentials = JSON.parse(
      readFileSync(
        join(
          config.userData,
          "control-runtime-v1",
          "provider-credentials.json",
        ),
        "utf8",
      ),
    );
    assert.equal(
      providerCredentials.schemaVersion,
      "crewon.provider-credentials.v1",
    );
    const noProvider =
      providerCredentials.activeProviderId === null &&
      Array.isArray(providerCredentials.bindings) &&
      providerCredentials.bindings.length === 0;
    assert.equal(noProvider, true);
    console.log(
      "CREWON_NATIVE_CONFIGURATION_APP_PROOF:" +
        JSON.stringify({
          phase: config.phase,
          nativeProcessId: process.pid,
          electron: process.versions.electron,
          formalMain: config.main,
          formalDocument: window.webContents.getURL(),
          runtime: "actual-source-Control-child",
          scope: profile.scope,
          localAccessGeneration: access.generation,
          settingsLabels,
          live,
          ready,
          selectedState: "disabled",
          configurationRevision: 1,
          parameters: config.parameters,
          configurationReads,
          configurationWrites,
          networkObservation: "formal-Main-fetch-only",
          supplierRequests,
          onlinePosts,
          noProvider,
        }),
    );
    // Production before-quit joins the actual Control and asset/HTTP owners.
    app.quit();
  })
  .catch((error) => {
    console.error("CREWON_NATIVE_CONFIGURATION_APP_FAILURE", error);
    app.quit();
    process.exitCode = 1;
  });
