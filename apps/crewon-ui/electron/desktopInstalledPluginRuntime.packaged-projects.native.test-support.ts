/** Test-only observer of the original running packaged Main and its original UI. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { app, BrowserWindow } from "electron";

type Config = Readonly<{
  phase: "save" | "reopen";
  executable: string;
  resourcesPath: string;
  appPath: string;
  userData: string;
  document: string;
  screenshotDirectory: string;
  title: string;
  brief: string;
  conceptName: string;
  prompt: string;
}>;
type HttpObservation = {
  method: string;
  path: string;
  status: number | null;
  action: string | null;
};
type Step =
  | "verify-original-package"
  | "original-window"
  | "native-local-management"
  | "original-settings"
  | "original-plugin-management"
  | "original-source-card"
  | "original-install"
  | "installed-disabled"
  | "original-enable"
  | "installed-enabled"
  | "original-back"
  | "original-module"
  | "original-project-dialog"
  | "original-project-fields"
  | "original-project-save"
  | "original-concept-editor"
  | "original-concept-fields"
  | "original-concept-save"
  | "original-project-list"
  | "original-project-read"
  | "original-concept-read"
  | "saved-inputs-read-back"
  | "original-disable"
  | "module-withdrawn"
  | "original-uninstall"
  | "installed-uninstalled"
  | "verify-observed-effects";

const identity = Object.freeze({
  pluginId: "crewon.short-drama",
  publisherId: "example.publisher",
  version: "9.0.0",
  packageDigest:
    "sha256:981c3bcdb7fc9c47186118a482bb1d8ec3dd1d4f95d3a09139f7a104dfba2334",
});
let observed = false;

/** External inspector loads this CJS observer after verifying the actual original Main. */
export async function observeOriginalPackagedApp(
  configPath: string,
): Promise<void> {
  let config: Config;
  try {
    assert.equal(
      observed,
      false,
      "packaged_projects_observer_already_attached",
    );
    observed = true;
    config = JSON.parse(readFileSync(configPath, "utf8")) as Config;
  } catch (error) {
    process.exitCode = 1;
    app.quit();
    throw error;
  }
  const originalFetch = globalThis.fetch;
  const http: HttpObservation[] = [];
  const screenshots: string[] = [];
  const packageUiUris = new Set<string>();
  const businessActionCounts = {
    projectCreates: 0,
    conceptCreates: 0,
    generationSubmissions: 0,
    querySubmissions: 0,
    imageSelections: 0,
    threadCreates: 0,
    recoveryStages: 0,
    otherMetadataWrites: 0,
    installs: 0,
    selectionChanges: 0,
  };
  let window: BrowserWindow | null = null;
  let currentStep: Step = "verify-original-package";
  let locale: "zh" | "en" = "zh";
  let sourceVerified = false;
  let observationFailed = false;
  const t = (zh: string, en: string) => (locale === "zh" ? zh : en);
  const moduleKey = JSON.stringify([identity.pluginId, "workbench"]);
  const sidebarSelector = `[data-host-module-target=${JSON.stringify(moduleKey)}]`;
  const moduleSelector =
    '[data-plugin-content-slot="main.content"] > ' +
    '[data-plugin-ui-root="workbench"][data-plugin-id="crewon.short-drama"]';
  const workbenchSelector =
    moduleSelector + ' section[aria-label="AI 短剧工作台"]';
  const manager = "document.querySelector('.installed-plugin-settings')";
  const cards = `Array.from(${manager}?.querySelectorAll('article.installed-plugin-card')??[])`;
  const installedCard = `${cards}.find(c=>c.querySelector('h4')?.textContent.trim()==='crewon.short-drama')`;
  const sourceCard = `${cards}.find(c=>c.querySelector('h4')?.textContent.trim()==='AI 短剧工作台'&&c.querySelector('header p')?.textContent.trim()==='example.publisher · 9.0.0')`;
  const workbench = `document.querySelector(${JSON.stringify(workbenchSelector)})`;

  function delay(milliseconds: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
  async function evaluate<T>(source: string): Promise<T> {
    assert.ok(
      window && !window.isDestroyed(),
      "packaged_projects_window_closed",
    );
    return window.webContents.executeJavaScript(source) as Promise<T>;
  }
  async function waitFor(expression: string, step: Step, timeout = 30_000) {
    currentStep = step;
    const deadline = Date.now() + timeout;
    while (!(await evaluate<boolean>(expression).catch(() => false))) {
      assert.ok(Date.now() < deadline, "packaged_projects_dom_timeout");
      await delay(20);
    }
  }
  async function clickButton(label: string, root: string, step: Step) {
    const buttons = `Array.from((${root})?.querySelectorAll('button')??[])`;
    const matches = `!b.disabled&&b.checkVisibility()&&(b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)})`;
    await waitFor(`${buttons}.some(b=>${matches})`, step);
    await evaluate(`${buttons}.find(b=>${matches}).click()`);
  }
  async function clickSelector(selector: string, step: Step) {
    const element = `document.querySelector(${JSON.stringify(selector)})`;
    await waitFor(
      `${element}?.checkVisibility()===true&&${element}?.disabled!==true`,
      step,
    );
    await evaluate(`${element}.click()`);
  }
  async function fill(selector: string, value: string, step: Step) {
    const element = `document.querySelector(${JSON.stringify(selector)})`;
    await waitFor(
      `${element}?.checkVisibility()===true&&${element}?.disabled===false&&${element}?.readOnly===false`,
      step,
    );
    await evaluate(`(()=>{
      const field=${element};
      const prototype=field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype,'value').set.call(field,${JSON.stringify(value)});
      field.dispatchEvent(new Event('input',{bubbles:true}));
      field.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
  }
  async function capture(stage: string) {
    await evaluate(
      "new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))",
    );
    const image = await window!.webContents.capturePage();
    assert.ok(!image.isEmpty(), "packaged_projects_capture_empty");
    const name = `packaged-projects-${config.phase}-${stage}.png`;
    writeFileSync(join(config.screenshotDirectory, name), image.toPNG());
    screenshots.push(name);
  }
  function safePath(url: URL) {
    return url.pathname
      .replace(/\/mounts\/[^/]+/gu, "/mounts/:mount")
      .replace(/\/ui-assets\/[^/]+/gu, "/ui-assets/:asset")
      .slice(0, 512);
  }
  async function actionName(
    input: Parameters<typeof originalFetch>[0],
    init?: Parameters<typeof originalFetch>[1],
  ) {
    try {
      const body =
        typeof init?.body === "string"
          ? init.body
          : init?.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : input instanceof Request
              ? await input.clone().text()
              : null;
      if (body === null || Buffer.byteLength(body) > 32 * 1024) return null;
      const parsed = JSON.parse(body) as { action?: unknown } | null;
      return typeof parsed?.action === "string" &&
        /^crewon\.[a-zA-Z0-9.-]{1,180}$/u.test(parsed.action)
        ? parsed.action
        : null;
    } catch {
      // Diagnostic parsing cannot replace or prevent the original request.
      observationFailed = true;
      return null;
    }
  }
  function countAction(action: string | null) {
    switch (action) {
      case "crewon.creative-projects.v1.createProject":
        businessActionCounts.projectCreates++;
        break;
      case "crewon.creative-projects.v1.createConcept":
        businessActionCounts.conceptCreates++;
        break;
      case "crewon.project-generations.v1.generateConcept":
        businessActionCounts.generationSubmissions++;
        break;
      case "crewon.project-generation-queries.v1.queryConceptGeneration":
        businessActionCounts.querySubmissions++;
        break;
      case "crewon.project-generation-selections.v1.selectConceptImage":
        businessActionCounts.imageSelections++;
        break;
      case "crewon.creative-projects.v1.renameProject":
      case "crewon.creative-projects.v1.setProjectState":
      case "crewon.creative-projects.v1.appendBrief":
      case "crewon.creative-projects.v1.appendConceptRevision":
        businessActionCounts.otherMetadataWrites++;
        break;
    }
  }
  async function observeSource(response: Response) {
    try {
      const text = await response.clone().text();
      if (Buffer.byteLength(text) > 128 * 1024) {
        observationFailed = true;
        return;
      }
      const value = JSON.parse(text) as { sources?: unknown };
      if (!Array.isArray(value.sources) || value.sources.length > 50) {
        observationFailed = true;
        return;
      }
      for (const candidate of value.sources) {
        if (
          candidate !== null &&
          typeof candidate === "object" &&
          !Array.isArray(candidate)
        ) {
          const source = candidate as Record<string, unknown>;
          if (
            Object.entries(identity).every(
              ([key, expected]) => source[key] === expected,
            )
          )
            sourceVerified = true;
        }
      }
    } catch {
      observationFailed = true;
    }
  }
  async function openSettings() {
    await clickSelector(".sidebar-account summary", "original-settings");
    await clickButton(
      t("设置", "Settings"),
      "document.querySelector('.sidebar-account')",
      "original-settings",
    );
    await waitFor(
      "document.querySelector('.settings-sidebar strong')!==null",
      "original-settings",
    );
    const labels = await evaluate<string[]>(
      "Array.from(document.querySelectorAll('.settings-sidebar strong')).map(e=>e.textContent.trim())",
    );
    const expected = [
      t("外观", "Appearance"),
      t("AI 模型", "AI models"),
      t("工具与扩展", "Tools & extensions"),
      t("助理与记忆", "Assistant & memory"),
      t("常规", "General"),
      t("账号", "Account"),
      t("安全与权限", "Safety & access"),
      t("网页应用", "Web apps"),
      t("连接管理", "Connected services"),
      t("键盘快捷键", "Keyboard shortcuts"),
    ];
    assert.deepEqual(
      [...labels].sort(),
      [...expected].sort(),
      "original_ten_settings_labels",
    );
    await clickButton(
      t("工具与扩展", "Tools & extensions"),
      "document.querySelector('.settings-sidebar')",
      "original-plugin-management",
    );
    await waitFor(
      `${manager}?.checkVisibility()===true&&${sourceCard}!==undefined`,
      "original-source-card",
    );
    assert.equal(
      sourceVerified,
      true,
      "actual_retained_short_drama9_source_identity",
    );
    return labels;
  }
  async function back() {
    await clickButton(
      t("返回", "Back"),
      "document.querySelector('.settings-sidebar')",
      "original-back",
    );
    await waitFor(
      "document.querySelector('.sidebar-account summary')?.checkVisibility()===true&&document.querySelector('.settings-command-window')===null",
      "original-back",
    );
  }
  async function installedState(state: "disabled" | "enabled" | "uninstalled") {
    const text =
      state === "disabled"
        ? t("已停用", "Disabled")
        : state === "enabled"
          ? t("已启用", "Enabled")
          : t("已卸载", "Uninstalled");
    const step: Step =
      state === "disabled"
        ? "installed-disabled"
        : state === "enabled"
          ? "installed-enabled"
          : "installed-uninstalled";
    await waitFor(
      `(${installedCard})?.querySelector('header > span')?.textContent.trim()===${JSON.stringify(text)}`,
      step,
    );
  }
  async function installAndEnable() {
    await clickButton(t("安装", "Install"), sourceCard, "original-install");
    await installedState("disabled");
    await clickButton(t("启用", "Enable"), installedCard, "original-enable");
    await installedState("enabled");
  }
  async function openModule() {
    await clickSelector(sidebarSelector, "original-module");
    await waitFor(
      `document.querySelector(${JSON.stringify(moduleSelector + " [data-short-drama-plugin]")})!==null&&${workbench}?.checkVisibility()===true&&!${workbench}.innerText.includes('正在等待模块就绪')`,
      "original-module",
    );
  }
  async function readSavedInputs(stage: string) {
    const briefSelector = workbenchSelector + " #creative-brief";
    if (
      await evaluate<boolean>(
        `document.querySelector(${JSON.stringify(briefSelector)})!==null`,
      )
    )
      await clickButton(
        "AI 短剧",
        `${workbench}?.querySelector('.breadcrumbs')`,
        "original-project-list",
      );
    const projectButtons = `Array.from(${workbench}?.querySelectorAll('button.project-card')??[])`;
    const matchesProject = `!b.disabled&&b.checkVisibility()&&b.querySelector('h2')?.textContent===${JSON.stringify(config.title)}`;
    await waitFor(
      `${projectButtons}.some(b=>${matchesProject})`,
      "original-project-read",
    );
    await evaluate(`${projectButtons}.find(b=>${matchesProject}).click()`);
    await waitFor(
      `document.querySelector(${JSON.stringify(briefSelector)})?.value===${JSON.stringify(config.brief)}&&${workbench}?.querySelector('.page-heading h1')?.textContent===${JSON.stringify(config.title)}`,
      "original-project-read",
    );
    const conceptButtons = `Array.from(${workbench}?.querySelectorAll('section[aria-label="概念输入"] button.version-card')??[])`;
    const matchesConcept = `!b.disabled&&b.checkVisibility()&&b.querySelector('strong')?.textContent===${JSON.stringify(config.conceptName)}`;
    await waitFor(
      `${conceptButtons}.some(b=>${matchesConcept})`,
      "original-concept-read",
    );
    await evaluate(`${conceptButtons}.find(b=>${matchesConcept}).click()`);
    await waitFor(
      `document.querySelector(${JSON.stringify(workbenchSelector + " #concept-prompt")})?.value===${JSON.stringify(config.prompt)}&&document.querySelector(${JSON.stringify(workbenchSelector + " #concept-prompt")})?.readOnly===true&&${workbench}?.querySelector('.concept-version-bar strong')?.textContent===${JSON.stringify(config.conceptName + " · 输入 v1")}`,
      "saved-inputs-read-back",
    );
    await capture(stage);
  }

  try {
    assert.deepEqual(
      Object.keys(config).sort(),
      [
        "phase",
        "executable",
        "resourcesPath",
        "appPath",
        "userData",
        "document",
        "screenshotDirectory",
        "title",
        "brief",
        "conceptName",
        "prompt",
      ].sort(),
    );
    assert.ok(config.phase === "save" || config.phase === "reopen");
    for (const field of [
      "executable",
      "resourcesPath",
      "appPath",
      "userData",
      "screenshotDirectory",
    ] as const)
      assert.ok(typeof config[field] === "string" && isAbsolute(config[field]));
    for (const [value, limit] of [
      [config.title, 160],
      [config.conceptName, 160],
      [config.prompt, 2000],
    ] as const)
      assert.ok(
        typeof value === "string" &&
          value.trim().length > 0 &&
          value.length <= limit,
      );
    assert.ok(
      typeof config.brief === "string" &&
        config.brief.trim().length > 0 &&
        Buffer.byteLength(config.brief) <= 8192,
    );
    assert.equal(app.isPackaged, true);
    assert.equal(
      (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp ===
        true,
      false,
    );
    assert.equal(
      Object.hasOwn(process.env, "ELECTRON_FORCE_IS_PACKAGED"),
      false,
    );
    assert.equal(app.getPath("userData"), config.userData);
    assert.equal(app.getAppPath(), config.appPath);
    assert.equal(process.execPath, config.executable);
    assert.equal(process.resourcesPath, config.resourcesPath);
    assert.match(process.version, /^v24\./u);
    assert.equal(
      JSON.parse(readFileSync(join(config.appPath, "package.json"), "utf8"))
        .main,
      "dist-electron/main.mjs",
    );

    // Delegate the exact original arguments, response and signal. Diagnostics are
    // read-only; this observer creates no request, identity, grant or transport.
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const action =
        method === "POST" &&
        /^\/api\/v1\/plugins\/ui\/mounts\/[^/]+\/actions$/u.test(url.pathname)
          ? await actionName(input, init)
          : null;
      const observation: HttpObservation = {
        method,
        path: safePath(url),
        status: null,
        action,
      };
      if (http.length < 512) http.push(observation);
      else observationFailed = true;
      countAction(action);
      if (method === "POST" && url.pathname === "/api/v1/threads")
        businessActionCounts.threadCreates++;
      if (method === "POST" && /\/mounts\/[^/]+\/recovery$/u.test(url.pathname))
        businessActionCounts.recoveryStages++;
      if (method === "POST" && url.pathname === "/api/v1/plugins/installations")
        businessActionCounts.installs++;
      if (
        method === "PUT" &&
        url.pathname === "/api/v1/plugins/selections/crewon.short-drama"
      )
        businessActionCounts.selectionChanges++;
      const response = await originalFetch.call(globalThis, input, init);
      observation.status = response.status;
      if (
        method === "GET" &&
        url.pathname === "/api/v1/plugins/sources" &&
        response.status === 200
      )
        await observeSource(response);
      return response;
    };

    currentStep = "original-window";
    await app.whenReady();
    const deadline = Date.now() + 30_000;
    while (!BrowserWindow.getAllWindows()[0]) {
      assert.ok(
        Date.now() < deadline,
        "packaged_projects_original_window_missing",
      );
      await delay(20);
    }
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    window = BrowserWindow.getAllWindows()[0]!;
    // Main's original onBeforeRequest security gate remains untouched.
    window.webContents.session.webRequest.onCompleted((details) => {
      if (details.statusCode !== 200 || packageUiUris.size >= 16) return;
      const match = /^crewon-plugin:\/\/ui\/[a-f0-9]{64}\/(.+)$/u.exec(
        details.url,
      );
      if (match && !/[?#]/u.test(match[1]!))
        packageUiUris.add(
          "crewon-plugin://ui/:binding/" + match[1]!.slice(0, 256),
        );
    });
    await waitFor(
      "['账号菜单：未登录','Account menu: Signed out'].includes(document.querySelector('.sidebar-account summary')?.getAttribute('aria-label'))&&['本机管理','Local management'].some(text=>document.querySelector('.sidebar-account')?.textContent.includes(text))&&document.querySelector('.crewon-auth-form')===null",
      "native-local-management",
    );
    locale = await evaluate<"zh" | "en">(
      "document.documentElement.lang.startsWith('zh')?'zh':'en'",
    );
    const formalDocument = new URL(window.webContents.getURL());
    assert.equal(formalDocument.protocol, "file:");
    assert.equal(formalDocument.href, new URL(config.document).href);
    assert.ok(formalDocument.pathname.endsWith("/dist/index.html"));
    assert.equal(
      await evaluate<boolean>(
        "typeof window.require==='undefined'&&typeof window.process==='undefined'&&typeof window.electron==='undefined'&&window.crewonDesktop?.version===1",
      ),
      true,
    );
    const access = await evaluate<{ generation: number } | null>(
      "window.crewonDesktop.runtime.localManagementAccess()",
    );
    assert.ok(access && Number.isSafeInteger(access.generation));
    await capture("account");
    const settingsLabels = await openSettings();
    await capture("settings");
    if (config.phase === "save") await installAndEnable();
    else await installedState("enabled");
    await back();
    await openModule();

    if (config.phase === "save") {
      await clickButton("新建项目", workbench, "original-project-dialog");
      const dialogSelector = workbenchSelector + " dialog[open]";
      await waitFor(
        `document.querySelector(${JSON.stringify(dialogSelector)})?.querySelector('h2')?.textContent==='新的创作项目'`,
        "original-project-dialog",
      );
      await fill(
        dialogSelector + " .modal-form input",
        config.title,
        "original-project-fields",
      );
      await fill(
        dialogSelector + " .modal-form textarea",
        config.brief,
        "original-project-fields",
      );
      await clickButton(
        "创建项目",
        `document.querySelector(${JSON.stringify(dialogSelector)})`,
        "original-project-save",
      );
      await waitFor(
        `document.querySelector(${JSON.stringify(dialogSelector)})===null&&document.querySelector(${JSON.stringify(workbenchSelector + " #creative-brief")})?.value===${JSON.stringify(config.brief)}`,
        "original-project-save",
      );
      await clickButton("新建概念输入", workbench, "original-concept-editor");
      await fill(
        workbenchSelector + ' input[aria-label="概念名称"]',
        config.conceptName,
        "original-concept-fields",
      );
      await fill(
        workbenchSelector + " #concept-prompt",
        config.prompt,
        "original-concept-fields",
      );
      await clickButton("保存概念输入", workbench, "original-concept-save");
      await waitFor(
        `document.querySelector(${JSON.stringify(workbenchSelector + " #concept-prompt")})?.readOnly===true&&${workbench}?.textContent.includes('概念输入 v1 已保存')`,
        "original-concept-save",
      );
    }
    await readSavedInputs(
      config.phase === "save" ? "saved-inputs" : "cold-original-inputs",
    );

    if (config.phase === "reopen") {
      assert.deepEqual(await openSettings(), settingsLabels);
      await clickButton(
        t("停用", "Disable"),
        installedCard,
        "original-disable",
      );
      await installedState("disabled");
      await capture("disabled");
      await back();
      await waitFor(
        `document.querySelector(${JSON.stringify(sidebarSelector)})===null&&document.querySelector(${JSON.stringify(moduleSelector)})===null`,
        "module-withdrawn",
      );
      assert.deepEqual(await openSettings(), settingsLabels);
      await clickButton(
        t("卸载", "Uninstall"),
        installedCard,
        "original-uninstall",
      );
      await installedState("uninstalled");
      await capture("uninstalled");
      await installAndEnable();
      await capture("reinstalled-enabled");
      await back();
      await openModule();
      await readSavedInputs("reinstalled-original-inputs");
    }
    currentStep = "verify-observed-effects";
    assert.equal(
      observationFailed,
      false,
      "packaged_projects_observation_incomplete",
    );
    assert.ok(
      [...packageUiUris].some((uri) => uri.endsWith("/ui.mjs")),
      "actual_original_package_ui_loaded",
    );
    const writes = config.phase === "save" ? 1 : 0;
    assert.deepEqual(businessActionCounts, {
      projectCreates: writes,
      conceptCreates: writes,
      generationSubmissions: 0,
      querySubmissions: 0,
      imageSelections: 0,
      threadCreates: 0,
      recoveryStages: 0,
      otherMetadataWrites: 0,
      installs: 1,
      selectionChanges: config.phase === "save" ? 1 : 3,
    });
    for (const observation of http.filter(
      (entry) =>
        entry.action === "crewon.creative-projects.v1.createProject" ||
        entry.action === "crewon.creative-projects.v1.createConcept" ||
        (entry.method === "POST" &&
          entry.path === "/api/v1/plugins/installations") ||
        (entry.method === "PUT" &&
          entry.path === "/api/v1/plugins/selections/crewon.short-drama"),
    ))
      assert.ok(
        observation.status === 200 || observation.status === 201,
        "original_ui_write_success",
      );
    process.stdout.write(
      "CREWON_PACKAGED_PROJECTS_APP_PROOF:" +
        JSON.stringify({
          phase: config.phase,
          pid: process.pid,
          userData: app.getPath("userData"),
          appPath: app.getAppPath(),
          executable: process.execPath,
          formalDocument: formalDocument.href,
          locale,
          localePreferenceChanged: false,
          settingsLabels,
          http,
          businessActionCounts,
          screenshots,
          packageUiUris: [...packageUiUris],
          savedInputsReadBack: true,
        }) +
        "\n",
    );
  } catch (error) {
    process.exitCode = 1;
    if (window) await capture("failure").catch(() => undefined);
    process.stderr.write(
      "CREWON_PACKAGED_PROJECTS_APP_FAILURE:" +
        JSON.stringify({
          phase:
            config.phase === "save" || config.phase === "reopen"
              ? config.phase
              : "unknown",
          step: currentStep,
          errorName:
            error instanceof Error &&
            [
              "Error",
              "AssertionError",
              "TypeError",
              "RangeError",
              "SyntaxError",
            ].includes(error.name)
              ? error.name
              : "unknown",
          http,
          businessActionCounts,
          screenshots,
        }) +
        "\n",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (window && !window.isDestroyed())
      window.webContents.session.webRequest.onCompleted(null);
    // Original Main owns before-quit and joins its original Supervisor/HTTP owners.
    // The parent separately verifies physical retirement before deleting its root.
    app.quit();
  }
}
