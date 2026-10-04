/** Test-only observer; the original packaged product owns Main, window, preload and transport. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { app, BrowserWindow } from "electron";
import { ControlApiClient } from "@crewon/control-client";
import {
  parsePluginUiRecoveryRequest,
  parsePluginUiRecoveryHintsResponse,
  type PluginUiRecoveryRequest,
} from "@crewon/contracts";
import type {
  PackagedRecoveryProof,
  PackagedRecoveryHttp,
} from "./desktopInstalledPluginRuntime.packaged-recovery.test-support.ts";

type Config = Readonly<{
  phase: "stage" | "hydrate";
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
  operationId: string;
  requests?: readonly PluginUiRecoveryRequest[];
}>;
type RecordValue = Record<string, unknown>;
type Step =
  | "package"
  | "window"
  | "account"
  | "settings"
  | "install"
  | "enable"
  | "back"
  | "module"
  | "project"
  | "concept"
  | "thread"
  | "stage"
  | "hydrate"
  | "inputs"
  | "proof";
const identity = Object.freeze({
  pluginId: "crewon.short-drama",
  publisherId: "example.publisher",
  version: "9.0.0",
  packageDigest:
    "sha256:981c3bcdb7fc9c47186118a482bb1d8ec3dd1d4f95d3a09139f7a104dfba2334",
});
const actions = Object.freeze({
  generation: "crewon.project-generations.v1.generateConcept",
  query: "crewon.project-generation-queries.v1.queryConceptGeneration",
  selection: "crewon.project-generation-selections.v1.selectConceptImage",
} as const);
let observed = false;
function record(value: unknown): RecordValue {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "packaged_recovery_record_invalid",
  );
  return value as RecordValue;
}

/** The three prepared commands are fixture inputs staged by the real authenticated client.
 * Their query/selection operation has never existed; no successful history or online execution is claimed. */
export async function observeOriginalPackagedApp(
  configPath: string,
): Promise<void> {
  let config: Config;
  try {
    assert.equal(observed, false);
    observed = true;
    config = JSON.parse(readFileSync(configPath, "utf8")) as Config;
  } catch (error) {
    process.exitCode = 1;
    app.quit();
    throw error;
  }
  const originalFetch = globalThis.fetch;
  const http: PackagedRecoveryHttp[] = [];
  const screenshots: string[] = [];
  const packageUiUris = new Set<string>();
  const businessActionCounts = {
    projectCreates: 0,
    conceptCreates: 0,
    threadCreates: 0,
    generationSubmissions: 0,
    querySubmissions: 0,
    imageSelections: 0,
    recoveryStages: 0,
    installs: 0,
    selectionChanges: 0,
    otherMetadataWrites: 0,
  };
  let window: BrowserWindow | null = null;
  let step: Step = "package";
  let locale: "zh" | "en" = "zh";
  let failedObservation = false;
  let sourceVerified = false;
  let currentLease: RecordValue | null = null;
  let thread: RecordValue | null = null;
  let concept: RecordValue | null = null;
  let authenticatedClient: ControlApiClient | null = null;
  let recovery: ReturnType<typeof parsePluginUiRecoveryHintsResponse> | null =
    null;
  let hydrateResponseAt = 0;
  const moduleKey = JSON.stringify([identity.pluginId, "workbench"]);
  const moduleSelector =
    '[data-plugin-content-slot="main.content"] > [data-plugin-ui-root="workbench"][data-plugin-id="crewon.short-drama"]';
  const workbenchSelector =
    moduleSelector + ' section[aria-label="AI 短剧工作台"]';
  const workbench = `document.querySelector(${JSON.stringify(workbenchSelector)})`;
  const installedCards =
    "Array.from(document.querySelector('.installed-plugin-settings')?.querySelectorAll('article.installed-plugin-card')??[])";
  const sourceCard = `${installedCards}.find(c=>c.querySelector('h4')?.textContent.trim()==='AI 短剧工作台'&&c.querySelector('header p')?.textContent.trim()==='example.publisher · 9.0.0')`;
  const installedCard = `${installedCards}.find(c=>c.querySelector('h4')?.textContent.trim()==='crewon.short-drama')`;
  const t = (zh: string, en: string) => (locale === "zh" ? zh : en);
  const delay = (milliseconds: number) =>
    new Promise<void>((done) => setTimeout(done, milliseconds));
  async function evaluate<T>(expression: string): Promise<T> {
    assert.ok(
      window && !window.isDestroyed(),
      "packaged_recovery_window_closed",
    );
    return window.webContents.executeJavaScript(expression) as Promise<T>;
  }
  async function wait(expression: string, next: Step) {
    step = next;
    const deadline = Date.now() + 30_000;
    while (!(await evaluate<boolean>(expression).catch(() => false))) {
      assert.ok(Date.now() < deadline, "packaged_recovery_dom_timeout");
      await delay(20);
    }
  }
  async function click(label: string, root: string, next: Step) {
    const buttons = `Array.from((${root})?.querySelectorAll('button')??[])`;
    const matches = `!b.disabled&&b.checkVisibility()&&(b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)})`;
    await wait(`${buttons}.some(b=>${matches})`, next);
    await evaluate(`${buttons}.find(b=>${matches}).click()`);
  }
  async function clickSelector(selector: string, next: Step) {
    const element = `document.querySelector(${JSON.stringify(selector)})`;
    await wait(
      `${element}?.checkVisibility()===true&&${element}?.disabled!==true`,
      next,
    );
    await evaluate(`${element}.click()`);
  }
  async function fill(selector: string, value: string, next: Step) {
    const element = `document.querySelector(${JSON.stringify(selector)})`;
    await wait(
      `${element}?.checkVisibility()===true&&${element}?.disabled===false&&${element}?.readOnly===false`,
      next,
    );
    await evaluate(
      `(()=>{const e=${element};const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  }
  async function capture(name: string) {
    await evaluate(
      "new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))",
    );
    const image = await window!.webContents.capturePage();
    assert.ok(!image.isEmpty());
    const filename = `packaged-recovery-${config.phase}-${name}.png`;
    writeFileSync(join(config.screenshotDirectory, filename), image.toPNG());
    screenshots.push(filename);
  }
  async function responseJson(response: Response): Promise<unknown> {
    const reader = response.clone().body?.getReader();
    assert.ok(reader, "packaged_recovery_response_empty");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        assert.ok(bytes <= 128 * 1024, "packaged_recovery_response_limit");
        chunks.push(part.value);
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async function requestCommand(
    input: Parameters<typeof originalFetch>[0],
    init?: RequestInit,
  ): Promise<RecordValue | null> {
    const text =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : input instanceof Request
            ? await input.clone().text()
            : null;
    if (text === null) return null;
    assert.ok(Buffer.byteLength(text) <= 32 * 1024);
    return record(JSON.parse(text));
  }
  function lease(): RecordValue {
    assert.ok(currentLease, "packaged_recovery_original_mount_missing");
    return currentLease;
  }
  function client(): ControlApiClient {
    const value = authenticatedClient;
    assert.ok(value, "packaged_recovery_original_client_missing");
    return value;
  }
  function restored() {
    const value = recovery;
    assert.ok(value, "packaged_recovery_actual_hydrate_missing");
    return value;
  }
  async function settings(): Promise<readonly string[]> {
    await clickSelector(".sidebar-account summary", "settings");
    await click(
      t("设置", "Settings"),
      "document.querySelector('.sidebar-account')",
      "settings",
    );
    await wait(
      "document.querySelectorAll('.settings-sidebar strong').length===10",
      "settings",
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
    assert.deepEqual([...labels].sort(), [...expected].sort());
    await capture("settings");
    await click(
      t("工具与扩展", "Tools & extensions"),
      "document.querySelector('.settings-sidebar')",
      "settings",
    );
    await wait(`${sourceCard}!==undefined`, "settings");
    assert.ok(sourceVerified, "packaged_recovery_retained_source_missing");
    return labels;
  }
  async function installed(state: "disabled" | "enabled") {
    const text =
      state === "disabled" ? t("已停用", "Disabled") : t("已启用", "Enabled");
    await wait(
      `${installedCard}?.querySelector('header > span')?.textContent.trim()===${JSON.stringify(text)}`,
      state === "disabled" ? "install" : "enable",
    );
  }
  async function inputsReadBack() {
    await wait(
      `document.querySelector(${JSON.stringify(workbenchSelector + " #creative-brief")})?.value===${JSON.stringify(config.brief)}&&document.querySelector(${JSON.stringify(workbenchSelector + " #concept-prompt")})?.value===${JSON.stringify(config.prompt)}&&document.querySelector(${JSON.stringify(workbenchSelector + " #concept-prompt")})?.readOnly===true&&${workbench}?.querySelector('.page-heading h1')?.textContent===${JSON.stringify(config.title)}&&${workbench}?.querySelector('.concept-version-bar strong')?.textContent===${JSON.stringify(config.conceptName + " · 输入 v1")}`,
      "inputs",
    );
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
        "operationId",
        ...(config.phase === "hydrate" ? ["requests"] : []),
      ].sort(),
    );
    assert.ok(config.phase === "stage" || config.phase === "hydrate");
    for (const key of [
      "executable",
      "resourcesPath",
      "appPath",
      "userData",
      "screenshotDirectory",
    ] as const)
      assert.ok(isAbsolute(config[key]));
    for (const value of [
      config.title,
      config.brief,
      config.conceptName,
      config.prompt,
    ])
      assert.ok(
        typeof value === "string" &&
          value.trim().length > 0 &&
          Buffer.byteLength(value) <= 8192,
      );
    assert.match(
      config.operationId,
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u,
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
    // Actual arguments, responses, headers and signals pass through unchanged. No renderer API is injected.
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      let command: RecordValue | null = null;
      try {
        if (
          method === "POST" &&
          (/\/mounts\/[^/]+\/(actions|recovery)$/u.test(url.pathname) ||
            url.pathname === "/api/v1/plugins/ui/mounts")
        )
          command = await requestCommand(input, init);
      } catch {
        failedObservation = true;
      }
      const action =
        typeof command?.action === "string" ? command.action : null;
      const entry = {
        method,
        path: url.pathname
          .replace(/\/mounts\/[^/]+/gu, "/mounts/:mount")
          .replace(/\/ui-assets\/[^/]+/gu, "/ui-assets/:asset")
          .slice(0, 512),
        status: null as number | null,
        action,
      };
      if (http.length < 512) http.push(entry);
      else failedObservation = true;
      if (
        method === "POST" &&
        /\/mounts\/[^/]+\/actions$/u.test(url.pathname)
      ) {
        if (action === "crewon.creative-projects.v1.createProject")
          businessActionCounts.projectCreates++;
        else if (action === "crewon.creative-projects.v1.createConcept")
          businessActionCounts.conceptCreates++;
        else if (action === actions.generation)
          businessActionCounts.generationSubmissions++;
        else if (action === actions.query)
          businessActionCounts.querySubmissions++;
        else if (action === actions.selection)
          businessActionCounts.imageSelections++;
        else if (
          [
            "crewon.creative-projects.v1.renameProject",
            "crewon.creative-projects.v1.setProjectState",
            "crewon.creative-projects.v1.appendBrief",
            "crewon.creative-projects.v1.appendConceptRevision",
          ].includes(action ?? "")
        )
          businessActionCounts.otherMetadataWrites++;
      }
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
      entry.status = response.status;
      try {
        if (
          method === "POST" &&
          response.status >= 200 &&
          response.status < 300 &&
          url.pathname.startsWith("/api/v1/")
        ) {
          const headers = new Headers(
            input instanceof Request ? input.headers : undefined,
          );
          new Headers(init?.headers).forEach((value, key) =>
            headers.set(key, value),
          );
          const token = /^Bearer (.+)$/u.exec(
            headers.get("authorization") ?? "",
          )?.[1];
          const origin = headers.get("origin"),
            csrfToken = headers.get("x-csrf-token");
          if (token && origin && csrfToken)
            authenticatedClient = new ControlApiClient({
              baseUrl: url.origin,
              accessToken: token,
              csrfToken,
              origin,
              fetch: globalThis.fetch,
            });
        }
        if (
          method === "GET" &&
          url.pathname === "/api/v1/plugins/sources" &&
          response.status === 200
        ) {
          const value = record(await responseJson(response));
          assert.ok(Array.isArray(value.sources) && value.sources.length <= 50);
          sourceVerified = value.sources.some((raw) =>
            Object.entries(identity).every(
              ([key, expected]) => record(raw)[key] === expected,
            ),
          );
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/plugins/ui/mounts" &&
          (response.status === 200 || response.status === 201) &&
          command?.pluginId === identity.pluginId
        ) {
          const value = record(await responseJson(response));
          currentLease = record(value.lease ?? value);
        }
        if (
          method === "POST" &&
          url.pathname === "/api/v1/threads" &&
          response.status === 201
        )
          thread = record(record(await responseJson(response)).thread);
        if (
          method === "POST" &&
          /\/actions$/u.test(url.pathname) &&
          action === "crewon.creative-projects.v1.createConcept" &&
          response.status === 200
        )
          concept = record(record(await responseJson(response)).output);
        if (
          method === "GET" &&
          /\/mounts\/[^/]+\/recovery$/u.test(url.pathname) &&
          response.status === 200
        ) {
          recovery = parsePluginUiRecoveryHintsResponse(
            await responseJson(response),
          );
          if (hydrateResponseAt === 0) hydrateResponseAt = Date.now();
        }
      } catch {
        failedObservation = true;
      }
      return response;
    };
    step = "window";
    await app.whenReady();
    const deadline = Date.now() + 30_000;
    while (!BrowserWindow.getAllWindows()[0]) {
      assert.ok(Date.now() < deadline);
      await delay(20);
    }
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    window = BrowserWindow.getAllWindows()[0]!;
    window.webContents.session.webRequest.onCompleted((details) => {
      const match = /^crewon-plugin:\/\/ui\/[a-f0-9]{64}\/(.+)$/u.exec(
        details.url,
      );
      if (
        details.statusCode === 200 &&
        match &&
        !/[?#]/u.test(match[1]!) &&
        packageUiUris.size < 16
      )
        packageUiUris.add(
          "crewon-plugin://ui/:binding/" + match[1]!.slice(0, 256),
        );
    });
    await wait(
      "['账号菜单：未登录','Account menu: Signed out'].includes(document.querySelector('.sidebar-account summary')?.getAttribute('aria-label'))&&['本机管理','Local management'].some(s=>document.querySelector('.sidebar-account')?.textContent.includes(s))&&document.querySelector('.crewon-auth-form')===null",
      "account",
    );
    locale = await evaluate<"zh" | "en">(
      "document.documentElement.lang.startsWith('zh')?'zh':'en'",
    );
    const formalDocument = new URL(window.webContents.getURL());
    assert.equal(formalDocument.protocol, "file:");
    assert.equal(formalDocument.href, new URL(config.document).href);
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
    const settingsLabels = await settings();
    if (config.phase === "stage") {
      await click(t("安装", "Install"), sourceCard, "install");
      await installed("disabled");
      await click(t("启用", "Enable"), installedCard, "enable");
    }
    await installed("enabled");
    await click(
      t("返回", "Back"),
      "document.querySelector('.settings-sidebar')",
      "back",
    );
    await wait(
      "document.querySelector('.settings-command-window')===null",
      "back",
    );
    await clickSelector(
      `[data-host-module-target=${JSON.stringify(moduleKey)}]`,
      "module",
    );
    await wait(
      `${workbench}?.checkVisibility()===true&&document.querySelector(${JSON.stringify(moduleSelector + " [data-short-drama-plugin]")})!==null&&!${workbench}.innerText.includes('正在等待模块就绪')`,
      "module",
    );
    const moduleReadyObservedAt = Date.now();
    let requests: readonly PluginUiRecoveryRequest[];
    if (config.phase === "stage") {
      assert.equal(
        restored().intents.length,
        0,
        "packaged_recovery_initial_hydrate_missing",
      );
      await click("新建项目", workbench, "project");
      const dialog = workbenchSelector + " dialog[open]";
      await fill(dialog + " .modal-form input", config.title, "project");
      await fill(dialog + " .modal-form textarea", config.brief, "project");
      await click(
        "创建项目",
        `document.querySelector(${JSON.stringify(dialog)})`,
        "project",
      );
      await wait(
        `document.querySelector(${JSON.stringify(dialog)})===null&&document.querySelector(${JSON.stringify(workbenchSelector + " #creative-brief")})?.value===${JSON.stringify(config.brief)}`,
        "project",
      );
      await click("新建概念输入", workbench, "concept");
      await fill(
        workbenchSelector + ' input[aria-label="概念名称"]',
        config.conceptName,
        "concept",
      );
      await fill(
        workbenchSelector + " #concept-prompt",
        config.prompt,
        "concept",
      );
      await click("保存概念输入", workbench, "concept");
      await inputsReadBack();
      await capture("saved-inputs");
      const generationControlsSelector = `section[aria-label="${t("生成任务会话", "Generation conversation")}"]`;
      const moduleHost = `document.querySelector('[data-plugin-content-slot="main.content"]')?.parentElement`;
      assert.equal(
        await evaluate<number>(
          `${moduleHost}?.querySelectorAll(${JSON.stringify(generationControlsSelector)}).length`,
        ),
        1,
        "packaged_recovery_original_generation_controls_missing",
      );
      const generationControls = `${moduleHost}?.querySelector(${JSON.stringify(generationControlsSelector)})`;
      await click(
        t("创建任务会话", "Create task conversation"),
        generationControls,
        "thread",
      );
      await wait(
        `${generationControls}?.innerText.includes(${JSON.stringify(t("任务会话已就绪", "Task conversation ready"))})`,
        "thread",
      );
      const originalThread = record(thread),
        originalConcept = record(concept);
      const project = record(originalConcept.project),
        asset = record(originalConcept.asset),
        revision = record(originalConcept.assetRevision);
      const reference = {
        projectId: project.projectId,
        assetId: asset.assetId,
        assetRevision: revision.assetRevision,
        expectedProjectRevision: project.revision,
        expectedAssetMetadataRevision: asset.revision,
      };
      const conversation = {
        threadId: originalThread.threadId,
        expectedThreadRevision: originalThread.revision,
      };
      requests = [
        parsePluginUiRecoveryRequest({
          action: actions.generation,
          input: {
            reference,
            ...conversation,
            idempotencyKey: "named-packaged-original-prepared-generation",
          },
        }),
        parsePluginUiRecoveryRequest({
          action: actions.query,
          input: {
            reference: {
              projectId: reference.projectId,
              assetId: reference.assetId,
              assetRevision: reference.assetRevision,
            },
            operationId: config.operationId,
            ...conversation,
            idempotencyKey: "named-packaged-original-prepared-query",
          },
        }),
        parsePluginUiRecoveryRequest({
          action: actions.selection,
          input: {
            reference,
            operationId: config.operationId,
            expectedOperationRevision: 1,
            resultIndex: 0,
            expectedSelectionRevision: 0,
            idempotencyKey: "named-packaged-original-prepared-selection",
          },
        }),
      ];
      const mounted = lease();
      assert.equal(mounted.selectionRevision, 2);
      assert.ok(typeof mounted.mountRef === "string");
      step = "stage";
      // No invoke call exists here. The real client checks its real HTTP ACK for each prepared command.
      const api = client();
      for (const request of requests) {
        const ack = await api.plugins.stageRecovery(mounted.mountRef, request, {
          signal: AbortSignal.timeout(10_000),
        });
        assert.equal(ack.disposition, "created");
        assert.deepEqual(ack.intent.request, request);
        assert.equal(ack.intent.phase, "prepared");
        assert.equal(ack.intent.dispatchAttemptCount, 0);
        assert.equal(ack.intent.receipt, null);
      }
      recovery = await api.plugins.getRecovery(mounted.mountRef, {
        signal: AbortSignal.timeout(10_000),
      });
      await capture("three-authenticated-prepared-acks");
    } else {
      assert.ok(Array.isArray(config.requests) && config.requests.length === 3);
      requests = config.requests.map(parsePluginUiRecoveryRequest);
      step = "hydrate";
      await wait(
        `document.body.innerText.includes(${JSON.stringify(t("生成请求待确认", "Generation request unconfirmed"))})&&document.body.innerText.includes(${JSON.stringify(t("查询请求待确认", "Query request unconfirmed"))})&&document.querySelector(${JSON.stringify(workbenchSelector + ' section[aria-label="概念图选用"]')})?.innerText.includes('选用回复丢失或尚未确认')`,
        "hydrate",
      );
      await inputsReadBack();
      await capture("cold-three-unknown-original-inputs");
    }
    const hints = restored().intents;
    assert.equal(hints.length, 3);
    assert.ok(
      hydrateResponseAt > 0 && hydrateResponseAt <= moduleReadyObservedAt,
    );
    for (const request of requests) {
      const hint = hints.find(
        (value) => value.request.action === request.action,
      );
      assert.ok(hint);
      assert.deepEqual(hint.request, request);
      for (const [key, expected] of Object.entries(identity))
        assert.equal(record(hint.sourcePin)[key], expected);
      assert.equal(hint.sourcePin.selectionRevision, 2);
      assert.equal(hint.sourcePin.contributionId, "workbench");
      assert.equal(hint.phase, "prepared");
      assert.equal(hint.dispatchAttemptCount, 0);
      assert.equal(hint.dispatchMayHaveOccurred, false);
      assert.equal(hint.receipt, null);
      assert.equal(hint.retryable, true);
    }
    assert.equal(
      failedObservation,
      false,
      "packaged_recovery_observation_failed",
    );
    assert.ok([...packageUiUris].some((uri) => uri.endsWith("/ui.mjs")));
    assert.deepEqual(businessActionCounts, {
      projectCreates: config.phase === "stage" ? 1 : 0,
      conceptCreates: config.phase === "stage" ? 1 : 0,
      threadCreates: config.phase === "stage" ? 1 : 0,
      generationSubmissions: 0,
      querySubmissions: 0,
      imageSelections: 0,
      recoveryStages: config.phase === "stage" ? 3 : 0,
      installs: config.phase === "stage" ? 1 : 0,
      selectionChanges: config.phase === "stage" ? 1 : 0,
      otherMetadataWrites: 0,
    });
    step = "proof";
    const proof: PackagedRecoveryProof = {
      phase: config.phase,
      pid: process.pid,
      formalDocument: formalDocument.href,
      executable: process.execPath,
      appPath: app.getAppPath(),
      userData: app.getPath("userData"),
      locale,
      localePreferenceChanged: false,
      settingsLabels,
      screenshots,
      packageUiUris: [...packageUiUris],
      http,
      businessActionCounts,
      requests,
      hints,
      savedInputsReadBack: true,
      hydrateResponseAt,
      moduleReadyObservedAt,
      fixtureStageClient: "original-authenticated-control-client",
      operationHistory: "not-created",
      operationId: config.operationId,
      onlineExecution: false,
    };
    process.stdout.write(
      "CREWON_PACKAGED_RECOVERY_APP_PROOF:" + JSON.stringify(proof) + "\n",
    );
  } catch {
    process.exitCode = 1;
    if (window && !window.isDestroyed())
      await capture("failure").catch(() => {});
    process.stderr.write(
      "CREWON_PACKAGED_RECOVERY_APP_FAILURE:" +
        JSON.stringify({
          phase: config.phase,
          step,
          http,
          businessActionCounts,
        }) +
        "\n",
    );
  } finally {
    globalThis.fetch = originalFetch;
    authenticatedClient = null;
    app.quit();
  }
}
