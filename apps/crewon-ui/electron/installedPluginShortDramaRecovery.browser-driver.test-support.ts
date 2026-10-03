/** Drives the original index/main/AuthGate/App with an independently installed short-drama package. */
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import type {
  GetConceptSelectionResponse,
  PluginUiCatalogResponse,
  PluginUiRecoveryHintsResponse,
  PluginUiRecoveryRequest,
  SelectConceptImageResponse,
  StagePluginUiRecoveryResponse,
} from "@crewon/contracts";

export type ShortDramaRecoveryBrowserInput = Readonly<{
  origin: string;
  certificateFingerprint: string;
  login: Readonly<{ username: string; password: string; displayName: string }>;
  packageIdentity: Readonly<{
    pluginId: string;
    publisherId: string;
    version: string;
    packageDigest: string;
  }>;
  contributionId: string;
  phase: "cold" | "selection-submit" | "cold-retry";
  stagedRequests: readonly PluginUiRecoveryRequest[];
  expectedSelection: Readonly<{
    selectionRevision: number;
    resultIndex: number;
    filename: string;
  }> | null;
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
  startedAt: number;
  headersAt: number | null;
  kind: "mutation" | "stage" | "read" | "other";
  action: string | null;
  input: unknown;
};
type ObservedResponse = Readonly<{
  method: string;
  path: string;
  action: string | null;
  status: number;
  receivedAt: number;
  body: unknown;
}>;
type NetworkRequest = Readonly<{
  method: string;
  path: string;
  action: string | null;
}>;

const actions = {
  generation: "crewon.project-generations.v1.generateConcept",
  query: "crewon.project-generation-queries.v1.queryConceptGeneration",
  selection: "crewon.project-generation-selections.v1.selectConceptImage",
  currentSelection:
    "crewon.project-generation-selections.v1.getConceptSelection",
} as const;
const mutationActions: readonly string[] = [
  actions.generation,
  actions.query,
  actions.selection,
];
const input = JSON.parse(
  readFileSync(process.argv[2], "utf8"),
) as ShortDramaRecoveryBrowserInput;
assert.equal(new URL(input.origin).origin, input.origin);
assert.equal(input.stagedRequests.length, 3);
assert.deepEqual(
  input.stagedRequests.map((request) => request.action).sort(),
  [...mutationActions].sort(),
);
assert.equal(input.phase === "cold", input.expectedSelection === null);
const selectionRequest = input.stagedRequests.find(
  (request) => request.action === actions.selection,
)!;
assert.ok(selectionRequest.action === actions.selection);

app.setPath("userData", input.userData);
let window: BrowserWindow | null = null;
const consoleMessages: string[] = [];
const requests = new Map<number, RequestProof>();
const networkRequests = new Map<string, NetworkRequest>();
const networkStatuses = new Map<
  string,
  { status: number; receivedAt: number }
>();
const responseReads = new Set<Promise<void>>();
const responses: ObservedResponse[] = [];
const observationFailures: string[] = [];
const screenshots: string[] = [];
let blockedProviderImages = 0;
const moduleKey = JSON.stringify([
  input.packageIdentity.pluginId,
  input.contributionId,
]);
const contentSelector = '[data-plugin-content-slot="main.content"]';
const moduleRootSelector =
  `${contentSelector} > [data-plugin-ui-root=${JSON.stringify(input.contributionId)}]` +
  `[data-plugin-id=${JSON.stringify(input.packageIdentity.pluginId)}]`;
const workbenchSelector = moduleRootSelector + " .drama-workbench";
const selectionSelector =
  workbenchSelector + ' section[aria-label="概念图选用"]';
const normalizedPath = (path: string) =>
  path.replace(/\/mounts\/[^/]+/u, "/mounts/:mount");

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
      // Trust only the named fixture's exact origin and certificate.
    }
    if (approved) event.preventDefault();
    done(approved);
  },
);

async function evaluate<T>(source: string): Promise<T> {
  return window!.webContents.executeJavaScript(source) as Promise<T>;
}
async function waitFor(source: string, label: string): Promise<void> {
  const until = Date.now() + 30_000;
  while (!(await evaluate<boolean>(source).catch(() => false))) {
    if (Date.now() >= until)
      throw new Error(
        `short_drama_recovery_timeout:${label}:${JSON.stringify({
          visible: await evaluate<string>(
            "document.body.innerText.slice(0,12000)",
          ).catch(() => "unavailable"),
          consoleMessages,
          observationFailures,
          requests: [...requests.values()],
        })}`,
      );
    await new Promise((done) => setTimeout(done, 20));
  }
}
async function waitForObserved(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  const until = Date.now() + 30_000;
  while (!predicate()) {
    assert.equal(observationFailures.length, 0, observationFailures.join(","));
    assert.ok(Date.now() < until, "short_drama_network_timeout:" + label);
    await new Promise((done) => setTimeout(done, 20));
  }
}
async function click(label: string, selector: string): Promise<void> {
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
async function clickSelector(selector: string): Promise<void> {
  await waitFor(
    `document.querySelector(${JSON.stringify(selector)})?.checkVisibility()===true`,
    "visible " + selector,
  );
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function fill(selector: string, value: string): Promise<void> {
  await waitFor(
    `document.querySelector(${JSON.stringify(selector)})!==null`,
    "field " + selector,
  );
  await evaluate(`(()=>{
    const field=document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)});
    field.dispatchEvent(new Event('input',{bubbles:true}));
    field.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
}
async function capture(label: string): Promise<void> {
  await evaluate(
    "new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))",
  );
  const pixels = await window!.webContents.capturePage();
  assert.ok(!pixels.isEmpty());
  const path = join(
    input.evidenceDirectory,
    "short-drama-recovery-" + input.phase + "-" + label + ".png",
  );
  writeFileSync(path, pixels.toPNG());
  screenshots.push(path);
}
/** Only coordinates the test controller; it never installs a renderer bridge or alters HTTP. */
async function checkpoint(
  stage: "module-ready" | "selection-submitted",
): Promise<void> {
  process.stdout.write(
    "CREWON_SHORT_DRAMA_RECOVERY_STAGE:" +
      JSON.stringify({ phase: input.phase, stage }) +
      "\n",
  );
  const path = join(input.checkpointDirectory, stage + ".continue");
  const until = Date.now() + 30_000;
  while (!existsSync(path)) {
    assert.ok(Date.now() < until, "short_drama_checkpoint_timeout:" + stage);
    await new Promise((done) => setTimeout(done, 20));
  }
}
function bodyAction(body: unknown): string | null {
  return body !== null && typeof body === "object" && "action" in body
    ? typeof body.action === "string"
      ? body.action
      : null
    : null;
}
function parseBody(text: string): unknown {
  assert.ok(Buffer.byteLength(text) <= 24 * 1024);
  return JSON.parse(text) as unknown;
}
function recordNetwork(): void {
  const contents = window!.webContents;
  contents.session.webRequest.onBeforeRequest((details, done) => {
    try {
      const url = new URL(details.url);
      if (
        url.hostname === "named-comfy-result.fixture.test" &&
        details.resourceType === "image"
      ) {
        blockedProviderImages++;
        done({ cancel: true });
        return;
      }
      if (url.origin === input.origin && requests.size < 1024) {
        let action: string | null = null,
          actionInput: unknown = null;
        if (
          details.method === "POST" &&
          (/\/mounts\/[^/]+\/actions$/u.test(url.pathname) ||
            /\/mounts\/[^/]+\/recovery$/u.test(url.pathname))
        ) {
          const bytes = Buffer.concat(
            (details.uploadData ?? []).map((part) => {
              assert.ok(part.bytes, "expected_in_memory_UI_action_body");
              return part.bytes;
            }),
          );
          const body = parseBody(bytes.toString("utf8"));
          action = bodyAction(body);
          if (action && mutationActions.includes(action)) {
            assert.ok(
              body !== null && typeof body === "object" && "input" in body,
            );
            actionInput = body.input;
          }
        }
        const mutation = action !== null && mutationActions.includes(action);
        requests.set(details.id, {
          id: details.id,
          method: details.method,
          path: normalizedPath(url.pathname),
          resourceType: details.resourceType,
          status: null,
          startedAt: Date.now(),
          headersAt: null,
          action,
          input: actionInput,
          kind:
            mutation && url.pathname.endsWith("/actions")
              ? "mutation"
              : mutation && url.pathname.endsWith("/recovery")
                ? "stage"
                : details.method === "GET" || (action !== null && !mutation)
                  ? "read"
                  : "other",
        });
      }
    } catch {
      observationFailures.push("UI_action_request_observation_failed");
    }
    done({});
  });
  contents.session.webRequest.onHeadersReceived((details, done) => {
    const request = requests.get(details.id);
    if (request) {
      request.status = details.statusCode;
      request.headersAt = Date.now();
    }
    done({});
  });

  // Observe only existing responses. Login, session and CSRF response bodies are excluded.
  contents.debugger.on("message", (_event, method, parameters) => {
    if (method === "Network.requestWillBeSent") {
      const value = parameters as {
        requestId: string;
        request: { url: string; method: string; postData?: string };
      };
      const url = new URL(value.request.url);
      if (url.origin !== input.origin) return;
      let action: string | null = null;
      if (
        (url.pathname.endsWith("/actions") ||
          /\/mounts\/[^/]+\/recovery$/u.test(url.pathname)) &&
        value.request.postData !== undefined
      ) {
        try {
          action = bodyAction(parseBody(value.request.postData));
        } catch {
          observationFailures.push("UI_action_response_locator_invalid");
        }
      }
      if (
        (value.request.method === "GET" &&
          url.pathname === "/api/v1/plugins/ui/catalog") ||
        /\/mounts\/[^/]+\/recovery$/u.test(url.pathname) ||
        action === actions.selection ||
        action === actions.currentSelection
      )
        networkRequests.set(value.requestId, {
          method: value.request.method,
          path: normalizedPath(url.pathname),
          action,
        });
    } else if (method === "Network.responseReceived") {
      const value = parameters as {
        requestId: string;
        response: { status: number };
      };
      if (networkRequests.has(value.requestId))
        networkStatuses.set(value.requestId, {
          status: value.response.status,
          receivedAt: Date.now(),
        });
    } else if (method === "Network.loadingFinished") {
      const { requestId } = parameters as { requestId: string };
      const request = networkRequests.get(requestId);
      if (!request) return;
      const read = (async () => {
        try {
          const result = (await contents.debugger.sendCommand(
            "Network.getResponseBody",
            { requestId },
          )) as { body: string; base64Encoded: boolean };
          const body = result.base64Encoded
            ? Buffer.from(result.body, "base64").toString("utf8")
            : result.body;
          assert.ok(Buffer.byteLength(body) <= 60 * 1024);
          if (responses.length < 64)
            responses.push({
              method: request.method,
              path: request.path,
              action: request.action,
              status: networkStatuses.get(requestId)?.status ?? 0,
              receivedAt: networkStatuses.get(requestId)?.receivedAt ?? 0,
              body: JSON.parse(body) as unknown,
            });
        } catch {
          observationFailures.push("recovery_response_observation_failed");
        }
      })();
      responseReads.add(read);
      void read.finally(() => responseReads.delete(read));
    }
  });
}
async function login(): Promise<void> {
  await waitFor(
    "document.querySelector('.crewon-auth-form input[name=username]')?.checkVisibility()===true",
    "original AuthGate login",
  );
  await capture("login");
  await fill('.crewon-auth-form input[name="username"]', input.login.username);
  await fill('.crewon-auth-form input[name="password"]', input.login.password);
  await click("进入 CrewON", ".crewon-auth-form");
  await waitFor(
    `document.querySelector('.sidebar-account summary')?.getAttribute('aria-label')===${JSON.stringify("账号菜单：" + input.login.displayName)}`,
    "original authenticated account",
  );
  assert.equal(
    await evaluate<boolean>(
      "typeof window.require==='undefined'&&typeof window.crewonDesktop==='undefined'&&document.documentElement.dataset.surface==='web'",
    ),
    true,
  );
  await capture("account");
}
async function readSettings() {
  await clickSelector(".sidebar-account summary");
  await click("设置", ".sidebar-account");
  await click("工具与扩展", ".settings-sidebar");
  await waitFor(
    `document.querySelector('.installed-plugin-settings')?.textContent.includes(${JSON.stringify(input.packageIdentity.pluginId)})`,
    "actual short-drama package in original settings",
  );
  const settings = await evaluate<{
    navigation: string[];
    styles: Record<string, string>;
    installedPackageText: string;
  }>(`(()=>{
    const panel=document.querySelector('.settings-command-window');
    return {navigation:Array.from(document.querySelectorAll('.settings-sidebar strong')).map(e=>e.textContent.trim()),
      installedPackageText:document.querySelector('.installed-plugin-settings').innerText,
      styles:{windowDisplay:getComputedStyle(panel).display,
        styleArtifacts:Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(e=>new URL(e.href).pathname).join(',')}};
  })()`);
  assert.equal(settings.styles.windowDisplay, "grid");
  for (const label of ["常规", "账号", "工具与扩展", "外观", "安全与权限"])
    assert.ok(settings.navigation.includes(label), label);
  await capture("settings");
  await click("返回", ".settings-sidebar");
  await waitFor(
    "document.querySelector('.sidebar-account summary')?.checkVisibility()===true",
    "original account footer after returning from settings",
  );
  return settings;
}
function latestRecovery(): PluginUiRecoveryHintsResponse | undefined {
  return responses
    .filter(
      (response) =>
        response.method === "GET" &&
        response.path.endsWith("/recovery") &&
        response.status === 200,
    )
    .at(-1)?.body as PluginUiRecoveryHintsResponse | undefined;
}
async function openModule() {
  await clickSelector(`[data-host-module-target=${JSON.stringify(moduleKey)}]`);
  await waitForObserved(
    () => latestRecovery()?.intents.length === 3,
    "hydrate",
  );
  const recovery = latestRecovery()!;
  assert.equal(recovery.version, "crewon.plugin-ui-recovery.v1");
  for (const staged of input.stagedRequests) {
    const hint = recovery.intents.find(
      (intent) => intent.request.action === staged.action,
    );
    assert.ok(hint);
    assert.deepEqual(hint.request, staged);
    assert.equal(hint.sourcePin.pluginId, input.packageIdentity.pluginId);
    assert.equal(hint.sourcePin.publisherId, input.packageIdentity.publisherId);
    assert.equal(hint.sourcePin.version, input.packageIdentity.version);
    assert.equal(
      hint.sourcePin.packageDigest,
      input.packageIdentity.packageDigest,
    );
    assert.equal(hint.sourcePin.contributionId, input.contributionId);
    assert.ok(hint.phase === "prepared" || hint.phase === "dispatched");
    assert.equal(hint.receipt, null);
    assert.equal(hint.retryable, true);
  }
  const catalog = responses
    .filter((response) => response.path === "/api/v1/plugins/ui/catalog")
    .flatMap((response) =>
      response.status === 200
        ? (response.body as PluginUiCatalogResponse).plugins
        : [],
    );
  assert.ok(
    catalog.some(
      (plugin) =>
        plugin.packageDigest === input.packageIdentity.packageDigest &&
        plugin.descriptor.pluginId === input.packageIdentity.pluginId &&
        plugin.descriptor.publisherId === input.packageIdentity.publisherId &&
        plugin.descriptor.version === input.packageIdentity.version &&
        plugin.descriptor.requires.some(
          (requirement) =>
            requirement.service === "crewon.plugin-ui-recovery" &&
            requirement.apiVersion === "1" &&
            requirement.optional === false,
        ),
    ),
    "actual catalog contains the separately installed recovery-required package",
  );
  await waitFor(
    `document.querySelector(${JSON.stringify(workbenchSelector)})?.checkVisibility()===true&&!document.querySelector(${JSON.stringify(workbenchSelector)}).innerText.includes('正在等待模块就绪')&&document.body.innerText.includes('生成请求待确认')&&document.body.innerText.includes('查询请求待确认')&&document.querySelector(${JSON.stringify(selectionSelector)})?.innerText.includes('选用回复丢失或尚未确认')`,
    "actual ready module restores all three UNKNOWN lanes",
  );
  const state = (await evaluate(`(()=>{
    const footer=document.querySelector('.sidebar-account');
    const bounds=footer.getBoundingClientRect();
    const module=document.querySelector(${JSON.stringify(workbenchSelector)});
    return {moduleReady:!module.innerText.includes('正在等待模块就绪'),
      shellDisplay:getComputedStyle(document.querySelector('.command-window')).display,
      accountVisible:footer.checkVisibility()&&bounds.bottom<=innerHeight+1,
      viewportHeight:innerHeight,accountBounds:{top:bounds.top,bottom:bounds.bottom},
      generationText:document.querySelector('section[aria-label="生成任务会话"]').innerText,
      queryText:document.querySelector('section[aria-label="原任务查询"]').innerText,
      selectionText:document.querySelector(${JSON.stringify(selectionSelector)}).innerText,
      workbenchText:module.innerText};
  })()`)) as Record<string, unknown>;
  assert.equal(state.moduleReady, true, JSON.stringify(state));
  assert.equal(state.shellDisplay, "grid");
  assert.equal(state.accountVisible, true, JSON.stringify(state));
  const moduleReadyObservedAt = Date.now(),
    recoveryResponseAt = responses
      .filter(
        (response) =>
          response.method === "GET" &&
          response.path.endsWith("/recovery") &&
          response.status === 200,
      )
      .at(-1)!.receivedAt;
  assert.ok(
    recoveryResponseAt > 0 && recoveryResponseAt <= moduleReadyObservedAt,
  );
  await capture("module-unknown");
  return { recovery, state, recoveryResponseAt, moduleReadyObservedAt };
}
const mutations = () =>
  [...requests.values()].filter((request) => request.kind === "mutation");
async function retrySelection() {
  const before = responses.length;
  await click("重试原选用", selectionSelector);
  await waitForObserved(
    () =>
      responses
        .slice(before)
        .some(
          (response) =>
            response.method === "POST" &&
            response.path.endsWith("/actions") &&
            response.action === actions.selection &&
            response.status === 200,
        ),
    "actual opaque selection receipt",
  );
  const receipt = responses
    .slice(before)
    .find(
      (response) =>
        response.method === "POST" &&
        response.path.endsWith("/actions") &&
        response.action === actions.selection &&
        response.status === 200,
    )!.body as { output: SelectConceptImageResponse };
  assert.equal(
    receipt.output.disposition,
    input.phase === "selection-submit" ? "committed" : "replayed",
  );
  assert.equal(receipt.output.selectionRevision, 1);
  assert.deepEqual(receipt.output.selection.reference, {
    projectId: selectionRequest.input.reference.projectId,
    assetId: selectionRequest.input.reference.assetId,
    assetRevision: selectionRequest.input.reference.assetRevision,
  });
  assert.equal(
    receipt.output.selection.operationId,
    selectionRequest.input.operationId,
  );
  assert.equal(
    receipt.output.selection.operationRevision,
    selectionRequest.input.expectedOperationRevision,
  );
  assert.equal(
    receipt.output.selection.resultIndex,
    selectionRequest.input.resultIndex,
  );
  await waitFor(
    `document.querySelector(${JSON.stringify(selectionSelector)})?.innerText.includes('原选用请求已确认')&&document.querySelector(${JSON.stringify(selectionSelector + " [data-selected-result-index]")})?.getAttribute('data-selected-result-index')===${JSON.stringify(String(input.expectedSelection!.resultIndex))}&&document.querySelector(${JSON.stringify(selectionSelector)})?.getAttribute('data-selection-revision')===${JSON.stringify(String(input.expectedSelection!.selectionRevision))}&&document.querySelector(${JSON.stringify(selectionSelector)})?.innerText.includes(${JSON.stringify(input.expectedSelection!.filename)})`,
    "accepted selection and independently read current pointer",
  );
  await waitForObserved(
    () =>
      responses.slice(before).some((response) => {
        if (
          response.action !== actions.currentSelection ||
          response.status !== 200
        )
          return false;
        const value = (response.body as { output: GetConceptSelectionResponse })
          .output;
        return (
          value.selectionRevision ===
            input.expectedSelection!.selectionRevision &&
          value.current?.resultIndex === input.expectedSelection!.resultIndex &&
          value.current?.filename === input.expectedSelection!.filename
        );
      }),
    "separate getConceptSelection response",
  );
  const current = responses
    .slice(before)
    .filter((response) => {
      if (
        response.action !== actions.currentSelection ||
        response.status !== 200
      )
        return false;
      const value = (response.body as { output: GetConceptSelectionResponse })
        .output;
      return (
        value.selectionRevision ===
          input.expectedSelection!.selectionRevision &&
        value.current?.resultIndex === input.expectedSelection!.resultIndex &&
        value.current?.filename === input.expectedSelection!.filename
      );
    })
    .at(-1)?.body as { output: GetConceptSelectionResponse } | undefined;
  assert.ok(
    current,
    "current pointer comes from the separate real getConceptSelection action",
  );
  const physical = mutations();
  assert.equal(physical.length, 1);
  assert.equal(physical[0].action, actions.selection);
  assert.deepEqual(physical[0].input, selectionRequest.input);
  assert.equal(physical[0].status, 200);
  const stage = [...requests.values()].find(
    (request) => request.kind === "stage",
  );
  assert.ok(stage);
  assert.equal(stage.action, actions.selection);
  assert.deepEqual(stage.input, selectionRequest.input);
  assert.ok(stage.status === 200 || stage.status === 201);
  assert.ok(
    stage.headersAt !== null && stage.headersAt <= physical[0].startedAt,
  );
  await waitForObserved(
    () =>
      responses
        .slice(before)
        .some(
          (response) =>
            response.method === "POST" &&
            response.path.endsWith("/recovery") &&
            (response.status === 200 || response.status === 201),
        ),
    "actual durable stage acknowledgement",
  );
  const stageResponse = responses
    .slice(before)
    .find(
      (response) =>
        response.method === "POST" &&
        response.path.endsWith("/recovery") &&
        (response.status === 200 || response.status === 201),
    )!;
  const stageAck = stageResponse.body as StagePluginUiRecoveryResponse;
  assert.equal(stageAck.version, "crewon.plugin-ui-recovery.v1");
  assert.deepEqual(stageAck.intent.request, selectionRequest);
  await capture("selection-confirmed");
  await checkpoint("selection-submitted");
  return {
    selectionReceipt: receipt.output,
    currentSelection: current.output,
    stageAck,
    selectionStageResponseAt: stage.headersAt,
    selectionActionStartedAt: physical[0].startedAt,
  };
}

process.stdout.write("SHORT_DRAMA_BROWSER_BOOT:loaded\n");
void app.whenReady().then(async () => {
  try {
    process.stdout.write("SHORT_DRAMA_BROWSER_BOOT:ready\n");
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
    recordNetwork();
    process.stdout.write("SHORT_DRAMA_BROWSER_BOOT:window\n");
    let navigationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        window.loadURL(input.origin + "/"),
        new Promise<never>((_, reject) => {
          navigationTimer = setTimeout(
            () =>
              reject(
                new Error(
                  "short_drama_navigation_timeout:" +
                    JSON.stringify({
                      requests: [...requests.values()],
                      consoleMessages,
                    }),
                ),
              ),
            30_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(navigationTimer);
    }
    process.stdout.write("SHORT_DRAMA_BROWSER_BOOT:navigated\n");
    // A real initial document must exist before Chromium can acknowledge Network.enable.
    // The original AuthGate is still logged out; all installed-module observations follow login.
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Network.enable");
    process.stdout.write("SHORT_DRAMA_BROWSER_BOOT:network\n");
    const entry = await evaluate<string>(
      "document.querySelector('script[type=module]')?.getAttribute('src')??''",
    );
    assert.match(entry, /^(?:\.\/|\/)assets\/index-[^/]+\.js$/u);
    await login();
    const settings = await readSettings();
    const restored = await openModule();
    assert.equal(mutations().length, 0);
    assert.equal(
      [...requests.values()].filter((request) => request.kind === "stage")
        .length,
      0,
    );
    await checkpoint("module-ready");
    const selected =
      input.phase === "cold"
        ? { selectionReceipt: null, currentSelection: null }
        : await retrySelection();
    await Promise.all([...responseReads]);
    assert.equal(observationFailures.length, 0, observationFailures.join(","));
    assert.equal(
      [...requests.values()].filter(
        (request) =>
          request.method === "POST" && request.path === "/api/v1/threads",
      ).length,
      0,
      "opening/recovery never prepares a new conversation",
    );
    assert.equal(mutations().length, input.phase === "cold" ? 0 : 1);
    const proof = {
      acceptance: "original-production-Web-App-installed-short-drama-recovery",
      phase: input.phase,
      electron: process.versions.electron,
      entry,
      nativeBridge: false,
      authGateLogin: true,
      originalAccountMenu: true,
      packageIdentity: input.packageIdentity,
      settings,
      recovery: restored.recovery,
      module: restored.state,
      recoveryResponseAt: restored.recoveryResponseAt,
      moduleReadyObservedAt: restored.moduleReadyObservedAt,
      ...selected,
      requests: [...requests.values()],
      mutations: mutations(),
      screenshots,
      consoleMessages,
      blockedProviderImages,
    };
    writeFileSync(
      join(
        input.evidenceDirectory,
        "short-drama-recovery-" + input.phase + "-proof.json",
      ),
      JSON.stringify(proof, null, 2) + "\n",
    );
    process.stdout.write(
      "CREWON_SHORT_DRAMA_RECOVERY_PROOF:" + JSON.stringify(proof) + "\n",
    );
    window.webContents.debugger.detach();
    window.destroy();
    app.exit(0);
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.stack : String(error)) + "\n",
    );
    window?.destroy();
    app.exit(1);
  }
});
