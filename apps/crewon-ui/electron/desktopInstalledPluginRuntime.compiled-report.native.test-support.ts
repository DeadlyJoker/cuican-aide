/** Test-only DOM/HTTP observer. Original compiled Main owns every product surface and lifetime. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

type Receipt = Readonly<{
  disposition: "committed" | "replayed";
  threadId: string;
  threadRevision: number;
  runId: string;
  messageId: string;
  configurationRevision: number;
}>;
type Config = Readonly<{
  main: string;
  userData: string;
  document: string;
  phase: "execute" | "reopen";
  subject: string;
  expectedTranscriptText: string;
  screenshotDirectory: string;
  checkpointDirectory: string;
  receipt?: Receipt;
}>;
type ReportCommand = Readonly<{
  action: "report.generate";
  input: Readonly<{
    threadId: string;
    expectedThreadRevision: number;
    idempotencyKey: string;
    input: Readonly<{ subject: string }>;
  }>;
}>;
type HttpObservation = {
  method: string;
  path: string;
  status: number | null;
  eventStream: boolean;
};
const config = JSON.parse(readFileSync(process.argv[2], "utf8")) as Config;
assert.ok(config.phase === "execute" || config.phase === "reopen");
assert.ok(config.subject.length > 0 && config.subject.length <= 2000);
assert.ok(config.expectedTranscriptText.length > 0);
app.setPath("userData", config.userData);

const actualFetch = globalThis.fetch.bind(globalThis);
const http: HttpObservation[] = [];
const consoleMessages: Readonly<{
  level: string;
  codes: readonly string[];
  characters: number;
}>[] = [];
const screenshots: string[] = [];
const packageUiUris = new Set<string>();
const physicalThreadStreams = new Map<string, number>();
let totalHttpRequests = 0;
let reportRequests = 0;
let observedCommand: ReportCommand | null = null;
let window: BrowserWindow | null = null;
let currentStep = "import-original-Main";
const taskSelector = 'section[aria-label="模块任务"]';
const contentSelector = '[data-plugin-content-slot="main.content"]';
const moduleKey = JSON.stringify(["example.professional", "studio"]);
const moduleRootSelector =
  contentSelector +
  ' > [data-plugin-ui-root="studio"][data-plugin-id="example.professional"]';

function keys(value: unknown, expected: readonly string[]) {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
  return value as Record<string, unknown>;
}
function boundedId(value: unknown) {
  assert.ok(
    typeof value === "string" && value.length > 0 && value.length <= 512,
  );
  assert.ok(!/[\u0000-\u001f\u007f]/u.test(value));
  return value;
}
function command(value: unknown): ReportCommand {
  const outer = keys(value, ["action", "input"]);
  assert.equal(outer.action, "report.generate");
  const request = keys(outer.input, [
    "threadId",
    "expectedThreadRevision",
    "idempotencyKey",
    "input",
  ]);
  boundedId(request.threadId);
  boundedId(request.idempotencyKey);
  assert.ok(Number.isSafeInteger(request.expectedThreadRevision));
  const business = keys(request.input, ["subject"]);
  assert.equal(business.subject, config.subject);
  return value as ReportCommand;
}
function originalCommand(): ReportCommand {
  assert.ok(observedCommand, "compiled_report_command_not_observed");
  return observedCommand;
}
function receipt(value: unknown): Receipt {
  const fields = keys(value, [
    "disposition",
    "threadId",
    "threadRevision",
    "runId",
    "messageId",
    "configurationRevision",
  ]);
  assert.ok(
    fields.disposition === "committed" || fields.disposition === "replayed",
  );
  for (const name of ["threadId", "runId", "messageId"])
    boundedId(fields[name]);
  assert.ok(Number.isSafeInteger(fields.threadRevision));
  assert.ok(Number.isSafeInteger(fields.configurationRevision));
  return value as Receipt;
}
function safePath(url: URL) {
  return url.pathname
    .replace(/\/mounts\/[^/]+/gu, "/mounts/:mount")
    .replace(/\/ui-assets\/[^/]+/gu, "/ui-assets/:asset")
    .slice(0, 512);
}
function delay(milliseconds: number, signal?: AbortSignal | null) {
  return new Promise<void>((accept, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      accept();
    }, milliseconds);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}
async function reportCheckpoint(signal?: AbortSignal | null) {
  const path = join(config.checkpointDirectory, "report-request.continue");
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    signal?.throwIfAborted();
    assert.ok(Date.now() < deadline, "compiled_report_checkpoint_timeout");
    await delay(20, signal);
  }
  signal?.throwIfAborted();
}
async function bodyText(
  input: Parameters<typeof actualFetch>[0],
  init?: Parameters<typeof actualFetch>[1],
) {
  if (typeof init?.body === "string") return init.body;
  if (init?.body instanceof Uint8Array)
    return new TextDecoder("utf-8", { fatal: true }).decode(init.body);
  if (init?.body instanceof ArrayBuffer)
    return new TextDecoder("utf-8", { fatal: true }).decode(init.body);
  if (input instanceof Request) return input.clone().text();
  throw new Error("compiled_report_request_body_unavailable");
}

// Observation only. The original fetch receives the exact input/init and its
// original signal. No request, response, authority, header or transport is replaced.
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  totalHttpRequests++;
  const observation: HttpObservation = {
    method,
    path: safePath(url),
    status: null,
    eventStream: false,
  };
  if (http.length < 512) http.push(observation);
  if (
    method === "POST" &&
    /^\/api\/v1\/plugins\/ui\/mounts\/[^/]+\/actions$/u.test(url.pathname)
  ) {
    const text = await bodyText(input, init);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // An unrelated invalid action still reaches the original product parser.
    }
    if ((parsed as { action?: unknown } | null)?.action === "report.generate") {
      assert.ok(
        Buffer.byteLength(text) <= 24 * 1024,
        "compiled_report_request_body_limit",
      );
      assert.equal(
        config.phase,
        "execute",
        "cold phase must not generate a new report",
      );
      assert.equal(
        reportRequests++,
        0,
        "only one explicit original report command",
      );
      observedCommand = command(parsed);
      // Only the command is printed: no mount capability, session or headers.
      process.stdout.write(
        "CREWON_COMPILED_REPORT_REQUEST:" +
          JSON.stringify(observedCommand) +
          "\n",
      );
      await reportCheckpoint(
        init?.signal ?? (input instanceof Request ? input.signal : null),
      );
    }
  }
  const response = await actualFetch(input, init);
  observation.status = response.status;
  observation.eventStream =
    response.headers.get("content-type")?.startsWith("text/event-stream") ??
    false;
  if (method === "GET" && response.status === 200 && observation.eventStream) {
    const thread = /^\/api\/v1\/threads\/([^/]+)\/events$/u.exec(url.pathname);
    if (thread && physicalThreadStreams.size < 32)
      physicalThreadStreams.set(
        thread[1]!,
        (physicalThreadStreams.get(thread[1]!) ?? 0) + 1,
      );
  }
  return response;
};

async function evaluate<T>(source: string): Promise<T> {
  assert.ok(window && !window.isDestroyed());
  return window.webContents.executeJavaScript(source) as Promise<T>;
}
async function waitFor(source: string, step: string, milliseconds = 30_000) {
  currentStep = step;
  const deadline = Date.now() + milliseconds;
  while (!(await evaluate<boolean>(source).catch(() => false))) {
    assert.ok(Date.now() < deadline, "compiled_report_dom_timeout");
    await delay(20);
  }
}
async function click(label: string, selector: string) {
  const root = `document.querySelector(${JSON.stringify(selector)})`;
  const buttons = `Array.from(${root}?.querySelectorAll('button')??[])`;
  const matches = `!b.disabled&&b.checkVisibility()&&(b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)})`;
  await waitFor(`${buttons}.some(b=>${matches})`, "button:" + label);
  await evaluate(`${buttons}.find(b=>${matches}).click()`);
}
async function clickSelector(selector: string) {
  await waitFor(
    `document.querySelector(${JSON.stringify(selector)})?.checkVisibility()===true`,
    "visible-original-control",
  );
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function fillSubject() {
  const selector = contentSelector + ' textarea[aria-label="报告主题"]';
  await waitFor(
    `document.querySelector(${JSON.stringify(selector)})?.disabled===false`,
    "original-report-form",
  );
  await evaluate(`(()=>{
    const field=document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(config.subject)});
    field.dispatchEvent(new Event('input',{bubbles:true}));
    field.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
}
async function capture(stage: string) {
  await evaluate(
    "new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))",
  );
  const image = await window!.webContents.capturePage();
  assert.ok(!image.isEmpty(), "compiled_report_capture_empty");
  const name = `compiled-report-${config.phase}-${stage}.png`;
  writeFileSync(join(config.screenshotDirectory, name), image.toPNG());
  screenshots.push(name);
}
async function settings() {
  await clickSelector(".sidebar-account summary");
  await click("设置", ".sidebar-account");
  await waitFor(
    "document.querySelector('.settings-sidebar strong')!==null",
    "original-settings",
  );
  const labels = await evaluate<string[]>(
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
    assert.ok(labels.includes(label), "original-settings-label:" + label);
  await click("工具与扩展", ".settings-sidebar");
  await waitFor(
    "document.querySelector('.installed-plugin-settings')?.textContent.includes('example.professional')",
    "original-settings-actual-installed-report",
  );
  await capture("settings");
  await click("返回", ".settings-sidebar");
  await waitFor(
    "document.querySelector('.sidebar-account summary')!==null",
    "original-App-restored",
  );
  return labels;
}
async function openModule() {
  await clickSelector(`[data-host-module-target=${JSON.stringify(moduleKey)}]`);
  await waitFor(
    `document.querySelector(${JSON.stringify(moduleRootSelector)})?.dataset.independentPluginVersion==='1.0.0'`,
    "actual-independent-report-package",
  );
  await waitFor(
    `document.querySelector(${JSON.stringify(taskSelector)})?.checkVisibility()===true`,
    "original-generic-task-controls",
  );
}
async function transcript(threadId: string) {
  await waitFor(
    `document.querySelector('[data-od-id="command-thread-room"]')?.textContent.includes(${JSON.stringify(config.expectedTranscriptText)})`,
    "actual-Worker-transcript",
    90_000,
  );
  currentStep = "physical-Main-thread-SSE";
  const deadline = Date.now() + 30_000;
  while (!physicalThreadStreams.has(encodeURIComponent(threadId))) {
    assert.ok(Date.now() < deadline, "compiled_report_thread_stream_timeout");
    await delay(20);
  }
  await capture("transcript");
  const characters = await evaluate<number>(
    "document.querySelector('[data-od-id=" +
      JSON.stringify("command-thread-room") +
      "]').innerText.length",
  );
  return { containsExpectedText: true, characters };
}

// Complete original Main's finite import before Electron emits ready so its
// protocol registration remains before ready. Never await ready at entry level.
await import(config.main);
async function runOriginalApp(): Promise<void> {
  try {
    await app.whenReady();
    const deadline = Date.now() + 30_000;
    while (!BrowserWindow.getAllWindows()[0]) {
      assert.ok(
        Date.now() < deadline,
        "compiled_report_original_window_missing",
      );
      await delay(20);
    }
    assert.equal(
      BrowserWindow.getAllWindows().length,
      1,
      "Main owns one original window",
    );
    window = BrowserWindow.getAllWindows()[0]!;
    window.webContents.on("console-message", (details) => {
      if (
        (details.level === "error" || details.level === "warning") &&
        consoleMessages.length < 32
      )
        consoleMessages.push({
          level: details.level,
          // Preserve known diagnostics only; never print arbitrary renderer text,
          // resource capabilities, credentials or response bodies from a console.
          codes: [
            "ERR_ABORTED",
            "ERR_FAILED",
            "ERR_FILE_NOT_FOUND",
            "ERR_CONNECTION_REFUSED",
            "ERR_TIMED_OUT",
            "ERR_BLOCKED_BY_CLIENT",
            "plugin_ui_mount_unavailable",
            "plugin_ui_read_failed",
            "control_runtime_unavailable",
            "desktop_http_response_timeout",
          ].filter((code) =>
            new RegExp("\\b" + code + "\\b", "u").test(details.message),
          ),
          characters: Math.min(details.message.length, 65_536),
        });
    });
    // Observe completion only; Main's sole onBeforeRequest security gate is intact.
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
      "document.querySelector('.sidebar-account summary')?.getAttribute('aria-label')==='账号菜单：未登录'&&document.querySelector('.sidebar-account')?.textContent.includes('本机管理')&&document.querySelector('.crewon-auth-form')===null",
      "genuine-Native-signed-out-local-management",
    );
    const formalDocument = new URL(window.webContents.getURL());
    const expectedDocument = new URL(config.document);
    assert.equal(formalDocument.protocol, "file:");
    assert.equal(formalDocument.href, expectedDocument.href);
    assert.ok(expectedDocument.pathname.endsWith("/dist/index.html"));
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
    let originalReceipt: Receipt;
    let transcriptSummary: {
      containsExpectedText: boolean;
      characters: number;
    };
    if (config.phase === "execute") {
      await openModule();
      await capture("module");
      await click("创建任务", taskSelector);
      await waitFor(
        `document.querySelector(${JSON.stringify(taskSelector)})?.textContent.includes('任务会话已就绪')`,
        "original-explicit-Thread-created",
      );
      // The generic control appears before the independent instance receives
      // its asynchronous update. Read the original thread through the real
      // refresh control and settle rendering before using the business form.
      await click("刷新任务状态", taskSelector);
      await waitFor(
        `(()=>{const root=document.querySelector(${JSON.stringify(taskSelector)});return root?.textContent.includes('任务会话已就绪')&&!root.textContent.includes('正在读取任务')&&Array.from(root.querySelectorAll('button')).some(b=>b.textContent.trim()==='刷新任务状态'&&!b.disabled)})()`,
        "original-task-context-refreshed",
      );
      await capture("thread-ready");
      await fillSubject();
      await click("创建报告任务", contentSelector);
      const receiptSelector = contentSelector + ' output[data-role="receipt"]';
      await waitFor(
        `document.querySelector(${JSON.stringify(receiptSelector)})?.textContent.startsWith('任务已受理：')`,
        "original-report-receipt",
      );
      const text = await evaluate<string>(
        `document.querySelector(${JSON.stringify(receiptSelector)}).textContent`,
      );
      originalReceipt = receipt(JSON.parse(text.slice("任务已受理：".length)));
      assert.equal(originalReceipt.disposition, "committed");
      const submitted = originalCommand();
      assert.equal(originalReceipt.threadId, submitted.input.threadId);
      assert.equal(
        originalReceipt.threadRevision,
        submitted.input.expectedThreadRevision + 1,
      );
      await capture("receipt");
      await click("打开任务", taskSelector);
      transcriptSummary = await transcript(originalReceipt.threadId);
    } else {
      originalReceipt = receipt(config.receipt);
      await clickSelector(
        `[data-linked-thread-id=${JSON.stringify(originalReceipt.threadId)}]`,
      );
      transcriptSummary = await transcript(originalReceipt.threadId);
      assert.equal(reportRequests, 0);
    }
    await openModule();
    await click("刷新任务状态", taskSelector);
    await waitFor(
      `document.querySelector(${JSON.stringify(taskSelector)})?.textContent.includes('已完成')`,
      "original-module-persisted-completed-Run",
    );
    await capture("completed-module");
    assert.ok(
      [...packageUiUris].some((uri) => /\.(?:js|mjs)$/u.test(uri)),
      "actual native package UI was fetched",
    );
    assert.equal(reportRequests, config.phase === "execute" ? 1 : 0);
    const proof = {
      acceptance: "original-compiled-Main-Native-report-window",
      phase: config.phase,
      nativeProcessId: process.pid,
      electron: process.versions.electron,
      formalMain: config.main,
      formalDocument: formalDocument.href,
      packageUiUris: [...packageUiUris],
      nativeBridgeVersion: 1,
      rendererNodeElectronAbsent: true,
      signedOutLocalManagement: true,
      localAccessGeneration: access.generation,
      settingsLabels,
      module: {
        pluginId: "example.professional",
        contributionId: "studio",
        version: "1.0.0",
        completed: true,
      },
      receipt: originalReceipt,
      transcript: transcriptSummary,
      sse: {
        physicalMainFetch: true,
        status: 200,
        threadStreamCount: physicalThreadStreams.get(
          encodeURIComponent(originalReceipt.threadId),
        ),
      },
      reportRequests,
      totalHttpRequests,
      retainedHttpObservations: http.length,
      httpObservationTruncated: totalHttpRequests > http.length,
      http,
      consoleMessages,
      screenshots,
      coldScope: "persisted-Thread-transcript-and-module-status-only",
    };
    process.stdout.write(
      "CREWON_COMPILED_REPORT_APP_PROOF:" + JSON.stringify(proof) + "\n",
    );
  } catch (error) {
    process.exitCode = 1;
    const failureDom = window
      ? await evaluate(
          `(()=>{const root=document.querySelector(${JSON.stringify(contentSelector)});const text=root?.querySelector('output[data-role="receipt"]')?.textContent??'';return {moduleVersion:root?.querySelector('[data-independent-plugin-version]')?.getAttribute('data-independent-plugin-version')??null,inputDisabled:root?.querySelector('textarea[aria-label="报告主题"]')?.disabled??null,receiptState:text.startsWith('任务已受理：')?'accepted':text==='任务未确认受理，可重试同一次请求。'?'unconfirmed':text===''?'empty':'other',threadReady:document.querySelector(${JSON.stringify(taskSelector)})?.textContent.includes('任务会话已就绪')??false}})()`,
        ).catch(() => null)
      : null;
    if (window) await capture("failure").catch(() => undefined);
    process.stderr.write(
      "CREWON_COMPILED_REPORT_APP_FAILURE:" +
        JSON.stringify({
          phase: config.phase,
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
          consoleMessages,
          http,
          failureDom,
        }) +
        "\n",
    );
  } finally {
    // Original Main's before-quit physically joins Supervisor/HTTP/asset owners.
    // The parent separately verifies actual child termination before removing data.
    app.quit();
  }
}
void runOriginalApp();
