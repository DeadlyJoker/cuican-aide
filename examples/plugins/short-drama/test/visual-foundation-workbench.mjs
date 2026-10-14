import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  foundationService,
  creativeParameters,
} from "./foundation-ui.test-support.mjs";

// Dev-only visual baseline for the integrated host workbench layout.
// Not wired into test/run-tests.mjs. Re-run with: node test/visual-foundation-workbench.mjs
process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??= resolve(
  new URL("../dist/50.1.0", import.meta.url).pathname,
);
process.env.CREWON_HOST_STYLE_DIRECTORY ??= resolve(
  new URL("../../../../apps/crewon-ui/src/styles", import.meta.url).pathname,
);
process.env.CREWON_TEXT_UI_VISUAL_OUTPUT ??= resolve(
  new URL(
    "../../../../output/ui-audit-shots/foundation-baseline",
    import.meta.url,
  ).pathname,
);
process.env.CREWON_BROWSER_AUTOMATION_MODULE ??=
  "/opt/homebrew/lib/node_modules/clawdbot/node_modules/playwright-core";

// Node ESM cannot import a bare directory; resolve the package entry explicitly.
const automationModule = process.env.CREWON_BROWSER_AUTOMATION_MODULE;
const automationEntry = automationModule.endsWith(".js")
  ? automationModule
  : join(automationModule, "index.js");
const automationNamespace = await import(pathToFileURL(automationEntry).href);
const { chromium } = automationNamespace.default ?? automationNamespace;
const packageDirectory = resolve(
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY,
);
const hostStyles = resolve(process.env.CREWON_HOST_STYLE_DIRECTORY);
const output = resolve(process.env.CREWON_TEXT_UI_VISUAL_OUTPUT);
await mkdir(output, { recursive: true });
const descriptor = JSON.parse(
  await readFile(join(packageDirectory, "crewon.plugin.json"), "utf8"),
);
const files = new Map(
  descriptor.files.map((file) => [`/${file.path}`, file.path]),
);
const styles = new Map(
  [
    "neutral-scale.css",
    "app.css",
    "original-shell-overrides.css",
    "team-workspace.css",
    "appearance.css",
  ].map((name) => [`/styles/${name}`, name]),
);

// Seed one creative-origin project with a saved (unconfirmed) proposal so the
// 创作方案 page renders its filled state: 创作想法卡片 / 编辑参数 / 确认方案 / 调整创作起点.
const service = foundationService();
const seeded = service.seed("creative", {
  title: "迟到的来信",
  text: "都市悬疑，三集短剧。快递员收到十年前自己寄出的信，决定寻找寄件人。",
});
const projectId = seeded.project.projectId;
service.proposal(
  projectId,
  "第一集：午夜派件时，林迟发现一封十年前由自己寄出的信，收信人地址早已拆迁。\n" +
    "第二集：他沿着旧快递站的存档追查寄件记录，发现当年有人替他保管过一个包裹。\n" +
    "第三集：真相揭开——信是父亲临终前以他的名义写下的约定，林迟决定赴约。",
);

const calls = [],
  navigationCalls = [],
  failedCalls = [],
  unimplemented = new Set();
/** Public DTO dispatcher for visual snapshots only. No SQL, identity or supplier claim. */
async function invoke(action, input) {
  calls.push({ action, input: structuredClone(input) });
  // Host navigation: capture openPage so stage switches are observable; the
  // fixture re-mounts with ?stage= instead of relying on a real host.
  if (action.startsWith("crewon.plugin-navigation.")) {
    navigationCalls.push({ action, input: structuredClone(input) });
    return {};
  }
  // Foundation + project metadata live in the shared fixture service.
  if (
    action.startsWith("crewon.project-foundation.v1.") ||
    action.startsWith("crewon.creative-projects.v1.") ||
    action === "crewon.project-generation-reads.v1.getConceptGeneration" ||
    action === "crewon.project-text-plans.v1.list" ||
    action === "crewon.project-conversations.v1.listConversations"
  )
    return service.services.invoke(action, input);
  // Remaining conversation actions are only fired by explicit clicks we do not
  // perform in this fixture; acknowledge with an empty payload.
  if (action.startsWith("crewon.project-conversations.v1.")) return {};
  if (action === "crewon.project-workspace-target.v1.resolveTarget") return {};
  // Cold-recovery reads: empty journals.
  if (
    action === "crewon.project-text-recovery.v1.getPending" ||
    action === "crewon.project-asset-recovery.v2.getPending" ||
    action === "crewon.project-media-generations.v2.getRecovery"
  )
    return { intent: null };
  // Empty read models for downstream stages (script/characters/art/references).
  if (action === "crewon.project-texts.v1.listArtifacts")
    return { artifacts: [], nextArtifactId: null };
  if (
    action === "crewon.project-texts.v1.getOutline" ||
    action === "crewon.project-texts.v1.getScript" ||
    action === "crewon.project-texts.v1.getArtifact"
  )
    return { view: null };
  if (action === "crewon.project-assets.v2.listAssets")
    return { assets: [], nextAssetId: null };
  if (action === "crewon.project-assets.v2.getAsset") return { view: null };
  if (action === "crewon.project-assets.v2.getRevision")
    return { contentRevision: null };
  if (action === "crewon.project-media-inputs.v1.getOptions")
    return {
      configuration: {
        revision: 1,
        workflows: [
          "krea2-reference-four-view",
          "flux2-three-reference-storyboard",
        ],
      },
    };
  if (action === "crewon.project-media-inputs.v1.listInputs")
    return { inputs: [], nextMediaInputId: null };
  if (action === "crewon.project-media-inputs.v1.loadInput")
    return { state: null };
  unimplemented.add(action);
  throw Object.assign(new Error(`visual_fixture_unimplemented:${action}`), {
    code: "visual_fixture_unimplemented",
  });
}

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Short ${descriptor.version} foundation workbench visual fixture</title><link rel="stylesheet" href="/styles/neutral-scale.css"><link rel="stylesheet" href="/styles/app.css"><link rel="stylesheet" href="/styles/original-shell-overrides.css"><link rel="stylesheet" href="/styles/team-workspace.css"><link rel="stylesheet" href="/styles/appearance.css"><style>html,body,#root,#theme-source{height:100%;width:100%;margin:0;overflow:hidden}#theme-source{display:block;min-width:0;min-height:0;border:0;padding:0}</style></head><body><div id="theme-source" class="screen-shell command-screen"><div id="root"></div></div><script type="module">
import definition from '/ui.mjs';
const params=new URL(location.href).searchParams;
const mode=params.get('mode')==='dark'?'dark':'light';
const stage=params.get('stage');
document.documentElement.dataset.theme=mode;
const computed=getComputedStyle(document.getElementById('theme-source'));
const tokens=Object.fromEntries([...computed].filter(name=>name.startsWith('--')).map(name=>[name,computed.getPropertyValue(name)]));
const projectId=${JSON.stringify(projectId)};
const context=stage?{projectId,stage}:{};
definition.mount(document.getElementById('root'),{schemaVersion:'crewon.plugin-ui-props.v1',contributionId:'workbench',theme:{mode,tokens},data:{locale:'zh',pluginUiReady:true,projectFoundationConnected:true,hostPresentation:{surface:'workbench',context},projectConversationContext:{creationWorkspaceId:'visual-workspace',creationWorkspaceName:'短剧创作工作空间'}}}, {async invoke(action,input,options){const response=await fetch('/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,input}),signal:options?.signal});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.code),{code:value.code});return value;}});
</script></body></html>`;

const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (path === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(html);
      return;
    }
    if (files.has(path)) {
      response.setHeader(
        "content-type",
        path.endsWith(".png") ? "image/png" : "text/javascript",
      );
      response.end(await readFile(join(packageDirectory, files.get(path))));
      return;
    }
    if (styles.has(path)) {
      response.setHeader("content-type", "text/css");
      response.end(await readFile(join(hostStyles, styles.get(path))));
      return;
    }
    if (path === "/invoke" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 65536)
          throw new Error("fixture_input_limit");
      }
      const { action, input } = JSON.parse(body);
      response.setHeader("content-type", "application/json");
      try {
        response.end(JSON.stringify((await invoke(action, input)) ?? null));
      } catch (error) {
        failedCalls.push({
          action,
          code: String(error.code ?? error.message ?? error),
        });
        response.writeHead(500);
        response.end(JSON.stringify({ code: error.code ?? error.message }));
      }
      return;
    }
    response.writeHead(404);
    response.end();
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: error.code ?? error.message }));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

// stage=null → 项目首页; otherwise hostPresentation.context.stage drives the page.
const shots = [];
for (const mode of ["light", "dark"])
  for (const stage of [
    null,
    "overview",
    "script",
    "characters",
    "art",
    "references",
  ])
    shots.push({
      name: `${stage ?? "home"}-${mode}`,
      width: 1440,
      height: 900,
      mode,
      stage,
    });
shots.push({
  name: "overview-narrow-light",
  width: 640,
  height: 900,
  mode: "light",
  stage: "overview",
});

const stageReady = {
  home: ".drama-project-home",
  overview: 'section[aria-label="创作方案"]',
  script: ".drama-project-editor",
  characters: ".drama-project-editor",
  art: ".drama-project-editor",
  references: ".drama-project-editor",
};

const report = [];
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.CREWON_BROWSER_TEST_CHANNEL ?? "chrome",
  });
  const page = await browser.newPage();
  const address = `http://127.0.0.1:${server.address().port}`;
  for (const shot of shots) {
    const pageErrors = [],
      consoleErrors = [];
    const onError = (error) => pageErrors.push(String(error));
    const onConsole = (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    };
    page.on("pageerror", onError);
    page.on("console", onConsole);
    await page.setViewportSize({ width: shot.width, height: shot.height });
    const url = shot.stage
      ? `${address}/?mode=${shot.mode}&stage=${shot.stage}`
      : `${address}/?mode=${shot.mode}`;
    await page.goto(url);
    const selector = stageReady[shot.stage ?? "home"];
    let ready = true;
    try {
      await page.locator(selector).first().waitFor({ timeout: 15000 });
    } catch {
      ready = false;
    }
    // Let async controller reads settle before capturing.
    await page.waitForTimeout(800);
    await page
      .locator(".drama-main")
      .evaluate((element) => {
        element.scrollTop = 0;
      })
      .catch(() => undefined);
    const file = join(output, `${shot.name}.png`);
    await page.screenshot({ path: file });
    const entry = { ...shot, file, ready, pageErrors, consoleErrors };
    // One-off layout probe: which ancestor constrains the content width?
    if (shot.name === "overview-light" && ready) {
      const probe = await page.evaluate(() => {
        const start = document.querySelector(".drama-foundation-workbench");
        const chain = [];
        let node = start;
        while (node && node !== document.documentElement) {
          const style = getComputedStyle(node);
          chain.push({
            tag: node.tagName.toLowerCase(),
            class: String(node.className).slice(0, 80),
            width: node.clientWidth,
            maxWidth: style.maxWidth,
            margin: style.margin,
            padding: style.padding,
            display: style.display,
          });
          node = node.parentElement;
        }
        return chain;
      });
      console.log("WIDTH-PROBE", JSON.stringify(probe, null, 1));
    }
    // Extra state on the light desktop 创作方案 page: open the proposal editor.
    if (shot.name === "overview-light" && ready) {      try {
        await page
          .getByRole("button", { name: "编辑方案", exact: true })
          .click({ timeout: 3000 });
        await page
          .locator("label", { hasText: "方案正文" })
          .locator("textarea")
          .waitFor({ timeout: 5000 });
        await page.waitForTimeout(300);
        const editFile = join(output, "overview-editing-light.png");
        await page.screenshot({ path: editFile });
        entry.extraShot = editFile;
      } catch (error) {
        entry.extraShotError = String(error);
      }
    }
    report.push(entry);
    page.off("pageerror", onError);
    page.off("console", onConsole);
    console.log(
      `${ready ? "ok" : "selector-miss"} ${shot.name} ` +
        `pageerror=${pageErrors.length} console=${consoleErrors.length}`,
    );
  }
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((yes, no) =>
    server.close((error) => (error ? no(error) : yes())),
  );
}
await writeFile(
  join(output, "visual-foundation-report.json"),
  JSON.stringify(
    {
      fixture: "public DTO server; not production identity/SQL",
      package: descriptor.version,
      projectId,
      parameters: creativeParameters,
      navigationCalls,
      failedCalls,
      unimplementedActions: [...unimplemented],
      shots: report,
      browserClosed: true,
      serverClosed: true,
    },
    null,
    2,
  ) + "\n",
);
console.log(`output: ${output}`);
console.log(`unimplemented actions: ${[...unimplemented].join(", ") || "none"}`);
