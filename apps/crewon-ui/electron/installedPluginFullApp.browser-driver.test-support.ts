/** Drives the unchanged production index/main/AuthGate/App in an isolated Chromium Web session. */
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
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
type Input = Readonly<{
  origin: string;
  certificateFingerprint: string;
  login: Readonly<{ username: string; password: string; displayName: string }>;
  packageIdentity: Readonly<{ pluginId: string; version: string }>;
  contributionId: string;
  configurationValue: string;
  configurationRevision: number;
  reportSubject: string;
  expectedTranscriptText: string;
  phase: "execute" | "reopen";
  receipt?: Receipt;
  evidenceDirectory: string;
  checkpointDirectory: string;
  userData: string;
}>;
type RequestProof = {
  id: number;
  method: string;
  path: string;
  resourceType: string;
  status: number | null;
  eventStream: boolean;
};
const input = JSON.parse(readFileSync(process.argv[2], "utf8")) as Input;
app.setPath("userData", input.userData);
let window: BrowserWindow | null = null;
const consoleMessages: string[] = [];
const requests = new Map<number, RequestProof>();
const moduleKey = JSON.stringify([
  input.packageIdentity.pluginId,
  input.contributionId,
]);
const taskSelector = 'section[aria-label="模块任务"]';
const contentSelector = '[data-plugin-content-slot="main.content"]';
const moduleRootSelector =
  `${contentSelector} > [data-plugin-ui-root=${JSON.stringify(input.contributionId)}]` +
  `[data-plugin-id=${JSON.stringify(input.packageIdentity.pluginId)}]`;

app.on(
  "certificate-error",
  (event, _contents, url, _error, certificate, done) => {
    let approved = false;
    try {
      approved =
        new URL(url).origin === input.origin &&
        new X509Certificate(certificate.data).fingerprint256 ===
          input.certificateFingerprint;
    } catch {
      // Only this fixture's exact origin and certificate are trusted.
    }
    if (approved) event.preventDefault();
    done(approved);
  },
);

async function evaluate<T>(source: string): Promise<T> {
  return window!.webContents.executeJavaScript(source) as Promise<T>;
}
async function waitFor(source: string, label: string, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (!(await evaluate<boolean>(source).catch(() => false))) {
    if (Date.now() >= until) {
      const visible = await evaluate<string>(
        "document.body.innerText.slice(0,6000)",
      ).catch(() => "unavailable");
      throw new Error(
        `full_app_web_timeout:${label}:${JSON.stringify({ consoleMessages, visible, requests: [...requests.values()] })}`,
      );
    }
    await new Promise((done) => setTimeout(done, 20));
  }
}
async function click(label: string, selector = "body") {
  const scope = `document.querySelector(${JSON.stringify(selector)})`;
  const value = JSON.stringify(label);
  const matches = `(b.getAttribute('aria-label')===${value}||b.textContent.trim()===${value})`;
  await waitFor(
    `Array.from(${scope}?.querySelectorAll('button')??[]).some(b=>!b.disabled&&b.checkVisibility()&&${matches})`,
    "button " + label,
  );
  await evaluate(
    `Array.from(${scope}.querySelectorAll('button')).find(b=>!b.disabled&&b.checkVisibility()&&${matches}).click()`,
  );
}
async function clickSelector(selector: string) {
  await waitFor(
    `document.querySelector(${JSON.stringify(selector)})?.checkVisibility()===true`,
    "visible " + selector,
  );
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function fill(selector: string, value: string) {
  await waitFor(
    `document.querySelector(${JSON.stringify(selector)})!==null`,
    "field " + selector,
  );
  await evaluate(`(()=>{
    const field=document.querySelector(${JSON.stringify(selector)});
    const prototype=field instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype,'value').set.call(field,${JSON.stringify(value)});
    field.dispatchEvent(new Event('input',{bubbles:true}));
    field.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
}
async function capture(name: string) {
  await evaluate(
    "new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))",
  );
  const pixels = await window!.webContents.capturePage();
  assert.ok(!pixels.isEmpty());
  writeFileSync(join(input.evidenceDirectory, name), pixels.toPNG());
}
/** Test-controller checkpoint; it never installs any renderer API or changes an HTTP response. */
async function checkpoint(stage: "module-open" | "thread-ready") {
  process.stdout.write(
    "CREWON_FULL_APP_STAGE:" + JSON.stringify({ stage }) + "\n",
  );
  const path = join(input.checkpointDirectory, stage + ".continue");
  const until = Date.now() + 30_000;
  while (!existsSync(path)) {
    assert.ok(Date.now() < until, "full_app_checkpoint_timeout:" + stage);
    await new Promise((done) => setTimeout(done, 20));
  }
}
async function login() {
  await waitFor(
    "document.querySelector('.crewon-auth-form input[name=username]')?.checkVisibility()===true",
    "original AgentPlatformAuthGate login form",
  );
  await capture("full-app-" + input.phase + "-login.png");
  await fill('.crewon-auth-form input[name="username"]', input.login.username);
  await fill('.crewon-auth-form input[name="password"]', input.login.password);
  await click("进入 CrewON", ".crewon-auth-form");
  await waitFor(
    `document.querySelector('.sidebar-account summary')?.getAttribute('aria-label')===${JSON.stringify("账号菜单：" + input.login.displayName)}`,
    "original authenticated account context",
  );
  assert.equal(
    await evaluate<boolean>(
      "typeof window.require==='undefined'&&typeof window.crewonDesktop==='undefined'&&document.documentElement.dataset.surface==='web'",
    ),
    true,
  );
  await capture("full-app-" + input.phase + "-account.png");
}
async function readSettings() {
  await clickSelector(".sidebar-account summary");
  await click("设置", ".sidebar-account");
  await click("工具与扩展", ".settings-sidebar");
  await waitFor(
    `document.querySelector('.installed-plugin-settings')?.textContent.includes(${JSON.stringify(input.packageIdentity.pluginId)})`,
    "actual installed package in original settings",
  );
  const navigation = await evaluate<string[]>(
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
    assert.ok(navigation.includes(label), label);
  await click("业务配置", ".installed-plugin-settings");
  await waitFor(
    `document.querySelector('.installed-plugin-configuration input[aria-label="organization"]')?.value===${JSON.stringify(input.configurationValue)}`,
    "original schema field reads installed PostgreSQL configuration",
  );
  const styles = await evaluate<Record<string, string>>(`(()=>{
    const panel=document.querySelector('.installed-plugin-configuration');
    const card=document.querySelector('.installed-plugin-card');
    return {windowDisplay:getComputedStyle(document.querySelector('.settings-command-window')).display,
      panelDisplay:getComputedStyle(panel).display,panelGap:getComputedStyle(panel).gap,
      cardPadding:getComputedStyle(card).padding,cardBorder:getComputedStyle(card).borderTopStyle,
      styleArtifacts:Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(e=>new URL(e.href).pathname).join(',')};
  })()`);
  assert.equal(styles.windowDisplay, "grid");
  assert.equal(styles.panelDisplay, "grid");
  assert.equal(styles.panelGap, "14px");
  assert.equal(styles.cardPadding, "18px");
  assert.equal(styles.cardBorder, "solid");
  assert.match(styles.styleArtifacts!, /CommandSettingsRoute-[^/]+\.css/u);
  await capture("full-app-" + input.phase + "-settings.png");
  await click("返回", ".settings-sidebar");
  await waitFor(
    "document.querySelector('.sidebar-account summary')!==null",
    "original App shell restored",
  );
  return { navigation, styles };
}
async function openModule() {
  const selector = `[data-host-module-target=${JSON.stringify(moduleKey)}]`;
  // The original shell groups installed modules in a collapsible plugin directory.
  // Use its visible control before selecting a module, as a user does.
  const directory = 'button[aria-label="插件"][aria-expanded]';
  await waitFor(
    `document.querySelector(${JSON.stringify(directory)})?.checkVisibility()===true`,
    "original plugin directory control",
  );
  if (
    await evaluate<boolean>(
      `document.querySelector(${JSON.stringify(directory)}).getAttribute('aria-expanded')==='false'`,
    )
  ) {
    await clickSelector(directory);
  }
  await clickSelector(selector);
  await waitFor(
    `document.querySelector(${JSON.stringify(moduleRootSelector)})?.dataset.independentPluginVersion===${JSON.stringify(input.packageIdentity.version)}`,
    "actual separately built installed UI module",
  );
  await waitFor(
    `document.querySelector(${JSON.stringify(taskSelector)})?.checkVisibility()===true`,
    "formal App legacy task navigation",
  );
  return evaluate<Record<string, string>>(`(()=>{
    const controls=document.querySelector(${JSON.stringify(taskSelector)});
    const shell=document.querySelector('.command-window');
    return {shellDisplay:getComputedStyle(shell).display,
      controlsDisplay:getComputedStyle(controls).display,controlsGap:getComputedStyle(controls).gap,
      moduleVersion:document.querySelector(${JSON.stringify(moduleRootSelector)}).dataset.independentPluginVersion};
  })()`);
}
async function waitForThreadStream(threadId: string) {
  const path = `/api/v1/threads/${encodeURIComponent(threadId)}/events`;
  const until = Date.now() + 30_000;
  // Control flushes immediately, while the unchanged BFF/edge pipes send their
  // headers with the first body chunk. An idle Thread's real heartbeat is 15s.
  while (
    !Array.from(requests.values()).some(
      (request) =>
        request.path === path && request.status === 200 && request.eventStream,
    )
  ) {
    assert.ok(
      Date.now() < until,
      "full_app_thread_stream_timeout:" +
        JSON.stringify(
          Array.from(requests.values()).filter(
            (request) => request.path === path,
          ),
        ),
    );
    await new Promise((done) => setTimeout(done, 20));
  }
}
async function readTranscript(threadId: string) {
  await waitFor(
    "document.querySelector('[data-od-id=" +
      JSON.stringify("command-thread-room") +
      "]')?.checkVisibility()===true",
    "original task transcript",
  );
  await capture("full-app-" + input.phase + "-task-open.png");
  await waitFor(
    `document.querySelector('[data-od-id="command-thread-room"]')?.textContent.includes(${JSON.stringify(input.expectedTranscriptText)})`,
    "actual Worker output in the original task transcript",
    90_000,
  );
  await waitFor(
    `Array.from(document.querySelectorAll('[data-od-id="command-thread-room"] .turn-group[data-status="completed"]')).some(turn=>turn.textContent.includes(${JSON.stringify(input.expectedTranscriptText)}))`,
    "original task transcript reaches its completed Turn with the actual Worker output",
    90_000,
  );
  await waitForThreadStream(threadId);
  await capture("full-app-" + input.phase + "-transcript.png");
  return evaluate<string>(
    "document.querySelector('[data-od-id=" +
      JSON.stringify("command-thread-room") +
      "]').innerText",
  );
}

void app.whenReady().then(async () => {
  try {
    window = new BrowserWindow({
      width: 1280,
      height: 900,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    window.webContents.on("console-message", (details) => {
      if (
        (details.level === "error" || details.level === "warning") &&
        consoleMessages.length < 32
      )
        consoleMessages.push(details.message.slice(0, 512));
    });
    window.webContents.session.webRequest.onSendHeaders((details) => {
      const url = new URL(details.url);
      if (url.origin !== input.origin || requests.size >= 512) return;
      requests.set(details.id, {
        id: details.id,
        method: details.method,
        path: url.pathname.replace(/\/mounts\/[^/]+/u, "/mounts/:mount"),
        resourceType: details.resourceType,
        status: null,
        eventStream: false,
      });
    });
    window.webContents.session.webRequest.onHeadersReceived((details, done) => {
      const request = requests.get(details.id);
      if (request) {
        request.status = details.statusCode;
        request.eventStream = Object.entries(
          details.responseHeaders ?? {},
        ).some(
          ([name, values]) =>
            name.toLowerCase() === "content-type" &&
            values.some((value) => value.startsWith("text/event-stream")),
        );
      }
      done({});
    });
    await window.loadURL(input.origin + "/");
    const entry = await evaluate<string>(
      "document.querySelector('script[type=module]')?.getAttribute('src')??''",
    );
    assert.match(entry, /^(?:\.\/|\/)assets\/index-[^/]+\.js$/u);
    await login();
    const settings = await readSettings();
    let receipt = input.receipt;
    let moduleStyles: Record<string, string>;
    let transcript: string;
    if (input.phase === "execute") {
      moduleStyles = await openModule();
      assert.equal(moduleStyles.shellDisplay, "grid");
      assert.equal(moduleStyles.controlsDisplay, "grid");
      assert.equal(moduleStyles.controlsGap, "12px");
      await capture("full-app-module-open.png");
      await checkpoint("module-open");
      await click("创建任务", taskSelector);
      await waitFor(
        `Array.from(document.querySelector(${JSON.stringify(taskSelector)})?.querySelectorAll('button')??[]).some(button=>button.textContent.trim()==='打开任务'&&!button.disabled)`,
        "explicit host createThread completed",
      );
      await capture("full-app-thread-ready.png");
      await checkpoint("thread-ready");
      await fill(
        contentSelector + ' textarea[aria-label="报告主题"]',
        input.reportSubject,
      );
      await click("创建报告任务", contentSelector);
      await waitFor(
        `document.querySelector(${JSON.stringify(contentSelector + ' output[data-role="receipt"]')})?.textContent.startsWith('任务已受理：')`,
        "actual installed package action receipt",
      );
      const text = await evaluate<string>(
        `document.querySelector(${JSON.stringify(contentSelector + ' output[data-role="receipt"]')}).textContent`,
      );
      receipt = JSON.parse(text.slice("任务已受理：".length)) as Receipt;
      assert.equal(receipt.disposition, "committed");
      assert.equal(receipt.configurationRevision, input.configurationRevision);
      assert.equal(
        await evaluate<boolean>(`(()=>{
        const field=document.querySelector(${JSON.stringify(contentSelector + ' textarea[aria-label="报告主题"]')});
        return field.value===${JSON.stringify(input.reportSubject)}&&field.disabled===true;
      })()`),
        true,
        "the accepted receipt retains the original submitted business form",
      );
      for (const field of [receipt.threadId, receipt.runId, receipt.messageId])
        assert.ok(typeof field === "string" && field.length > 0);
      await capture("full-app-report-receipt.png");
      await click("打开任务", taskSelector);
      transcript = await readTranscript(receipt.threadId);
    } else {
      assert.ok(receipt);
      await clickSelector(
        `[data-linked-thread-id=${JSON.stringify(receipt.threadId)}]`,
      );
      transcript = await readTranscript(receipt.threadId);
      moduleStyles = await openModule();
    }
    await openModule();
    await waitFor(
      `Array.from(document.querySelector(${JSON.stringify(taskSelector)})?.querySelectorAll('button')??[]).some(button=>button.textContent.trim()==='打开任务'&&!button.disabled)`,
      "legacy navigation retains the original confirmed task after completion",
    );
    await capture("full-app-" + input.phase + "-completed-module.png");
    assert.ok([...requests.values()].some((request) => request.eventStream));
    const proof = {
      acceptance: "unchanged-production-Web-full-App",
      phase: input.phase,
      electron: process.versions.electron,
      entry,
      nativeBridge: false,
      authGateLogin: true,
      originalAccountMenu: true,
      settings,
      moduleStyles,
      receipt,
      transcript,
      requests: [...requests.values()],
      consoleMessages,
    };
    writeFileSync(
      join(
        input.evidenceDirectory,
        "full-app-browser-" + input.phase + "-proof.json",
      ),
      JSON.stringify(proof, null, 2) + "\n",
    );
    process.stdout.write(
      "CREWON_FULL_APP_PROOF:" + JSON.stringify(proof) + "\n",
    );
    window.destroy();
    app.exit(0);
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    window?.destroy();
    app.exit(1);
  }
});
