import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { recoveryTextService } from "./text-recovery.test-support.mjs";

// Dev-only browser verification. The package itself has no browser automation dependency.
const { chromium } = await import(
  process.env.CREWON_BROWSER_AUTOMATION_MODULE ?? "playwright"
);
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
const service = recoveryTextService();
const { project } = service.metadata.create(
  "迟到的来信",
  "都市悬疑，三集短剧。快递员收到十年前自己寄出的信，决定寻找寄件人。",
);
// Explicit public DTO ledger for appearance checks; no production Thread or Run.
const bindings = [],
  conversationCalls = [];
async function invoke(action, input) {
  if (!action.startsWith("crewon.project-conversations.v1."))
    return service.services.invoke(action, input);
  conversationCalls.push({ action, input: structuredClone(input) });
  assert.equal(input.projectId, project.projectId);
  if (action.endsWith(".listConversations"))
    return { bindings, nextThreadId: null };
  if (action.endsWith(".openConversation"))
    return {
      binding: bindings.find((value) => value.threadId === input.threadId),
    };
  assert.equal(action, "crewon.project-conversations.v1.createConversation");
  assert.equal(input.workspaceId, "visual-workspace");
  const binding = {
    bindingId: "visual-binding",
    projectId: project.projectId,
    threadId: "visual-thread",
    workspaceId: input.workspaceId,
    revision: 1,
    state: "active",
    source: {
      pluginId: descriptor.pluginId,
      publisherId: descriptor.publisherId,
      version: descriptor.version,
      packageDigest: "sha256:" + "a".repeat(64),
      selectionRevision: 1,
    },
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
  };
  bindings.push(binding);
  return { disposition: "committed", binding };
}
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Short ${descriptor.version} module visual fixture</title><link rel="stylesheet" href="/styles/neutral-scale.css"><link rel="stylesheet" href="/styles/app.css"><link rel="stylesheet" href="/styles/original-shell-overrides.css"><link rel="stylesheet" href="/styles/team-workspace.css"><link rel="stylesheet" href="/styles/appearance.css"><style>html,body,#root,#theme-source{height:100%;width:100%;margin:0;overflow:hidden}#theme-source{display:block;min-width:0;min-height:0;border:0;padding:0}</style></head><body><div id="theme-source" class="screen-shell command-screen"><div id="root"></div></div><script type="module">
import definition from '/ui.mjs';
const mode=new URL(location.href).searchParams.get('mode')==='dark'?'dark':'light';
document.documentElement.dataset.theme=mode;
const computed=getComputedStyle(document.getElementById('theme-source'));
const tokens=Object.fromEntries([...computed].filter(name=>name.startsWith('--')).map(name=>[name,computed.getPropertyValue(name)]));
definition.mount(document.getElementById('root'),{schemaVersion:'crewon.plugin-ui-props.v1',contributionId:'workbench',theme:{mode,tokens},data:{pluginUiReady:true,projectConversationContext:{creationWorkspaceId:'visual-workspace',creationWorkspaceName:'短剧创作工作空间'}}}, {async invoke(action,input,options){const response=await fetch('/invoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,input}),signal:options?.signal});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.code),{code:value.code});return value;}});
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
      response.end(JSON.stringify(await invoke(action, input)));
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
let browser;
const checks = [],
  errors = [];
try {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.CREWON_BROWSER_TEST_CHANNEL ?? "chrome",
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const address = `http://127.0.0.1:${server.address().port}`;
  for (const [name, width, height, mode] of [
    ["desktop", 1440, 900, "light"],
    ["narrow", 640, 900, "light"],
    ["low-height", 1440, 520, "light"],
    ["dark", 1440, 900, "dark"],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(`${address}/?mode=${mode}`);
    await page.locator(".project-card").first().click();
    await page
      .getByRole("button", { name: "新建项目对话", exact: true })
      .waitFor();
    if (bindings.length === 0)
      await page
        .getByRole("button", { name: "新建项目对话", exact: true })
        .click();
    await page.getByRole("button", { name: "进入对话", exact: true }).waitFor();
    await page.getByRole("button", { name: "进入对话", exact: true }).click();
    await page.getByText("已请求打开项目对话。", { exact: true }).waitFor();
    await page.locator(".drama-main").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: join(output, `conversation-${name}.png`) });
    const conversationMeasurements = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      contentWidth: document.querySelector(".drama-content").clientWidth,
      scrollWidth: document.querySelector(".drama-content").scrollWidth,
    }));
    assert.ok(
      conversationMeasurements.documentWidth <= width &&
        conversationMeasurements.scrollWidth <=
          conversationMeasurements.contentWidth + 1,
    );
    checks.push({
      name: `conversation-${name}`,
      width,
      height,
      mode,
      measurements: conversationMeasurements,
      fixtureThreadOnly: true,
    });
    await page.locator(".stage-item").nth(1).click();
    await page.getByLabel("大纲标题", { exact: true }).waitFor();
    await page
      .getByLabel("一句话故事", { exact: true })
      .fill("快递员收到一封来自过去的信，寄件人竟是自己。");
    await page
      .getByLabel("故事梗概", { exact: true })
      .fill(
        `午夜，快递员发现信封上是自己的笔迹。他找到旧快递站，才知道十年前有人等过自己。每集一个线索，最后揭开被遗忘的约定。\n本次视觉场景：${name}`,
      );
    if (
      (await page
        .getByRole("button", { name: "移除第 1 集", exact: true })
        .count()) === 0
    )
      await page.getByRole("button", { name: "添加一集", exact: true }).click();
    await page.getByLabel("第 1 集标题", { exact: true }).fill("午夜快递");
    await page
      .getByLabel("第 1 集故事", { exact: true })
      .fill("他拆开一封迟到十年的信。结尾：收件人的照片里出现了自己。");
    await page
      .getByRole("button", { name: "保存候选版本", exact: true })
      .click();
    await page
      .getByText("候选已保存，采用后成为后续阶段的来源。", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "采用此版本", exact: true }).click();
    await page.getByText("已采用所选内容版本。", { exact: true }).waitFor();
    const measurements = await page.evaluate(() => {
      const root = document.querySelector(".drama-workbench"),
        content = document.querySelector(".drama-content");
      return {
        viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        contentWidth: content.clientWidth,
        scrollWidth: content.scrollWidth,
        layoutColumns: getComputedStyle(
          document.querySelector(".detail-layout"),
        ).gridTemplateColumns,
        textColor: getComputedStyle(root).color,
        background: getComputedStyle(root).backgroundColor,
        scrollerHeight: document.querySelector(".drama-main").clientHeight,
        scrollerContent: document.querySelector(".drama-main").scrollHeight,
      };
    });
    assert.ok(
      measurements.documentWidth <= width &&
        measurements.scrollWidth <= measurements.contentWidth + 1,
      `${name} horizontal overflow`,
    );
    assert.notEqual(measurements.textColor, measurements.background);
    await page.locator(".drama-main").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: join(output, `story-${name}.png`) });
    await page
      .getByRole("button", { name: "第 1 集 · 午夜快递", exact: true })
      .click();
    await page.getByLabel("剧本标题", { exact: true }).waitFor();
    if ((await page.getByLabel("第 1 场地点", { exact: true }).count()) === 0)
      await page.getByRole("button", { name: "添加场次", exact: true }).click();
    await page.getByLabel("第 1 场地点", { exact: true }).fill("旧快递站");
    await page.getByLabel("第 1 场时间", { exact: true }).fill("午夜");
    await page
      .getByLabel("第 1 场动作", { exact: true })
      .fill("他用手电照亮信封，慢慢读出熟悉的字迹。");
    await page.locator(".drama-main").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: join(output, `script-${name}.png`) });
    checks.push({ name, width, height, mode, measurements });
  }
  await page.setViewportSize({ width: 640, height: 900 });
  await page.locator(".stage-item").nth(1).click();
  await page.getByRole("button", { name: "故事大纲", exact: true }).click();
  const synopsis = "原请求重启后仍然保留。\n快递员决定寻找那封信的来源。";
  await page.getByLabel("故事梗概", { exact: true }).fill(synopsis);
  service.loseBeforeNextWrite();
  await page.getByRole("button", { name: "保存候选版本", exact: true }).click();
  await page
    .getByRole("button", { name: "用原请求重试", exact: true })
    .waitFor();
  const writeCount = service.writeCalls.length;
  await page.reload();
  await page.locator(".project-card").first().click();
  await page
    .getByRole("button", { name: "用原请求重试", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("故事梗概", { exact: true }).inputValue(),
    synopsis,
  );
  assert.equal(
    service.writeCalls.length,
    writeCount,
    "cold mount must not repeat a business write",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "保存候选版本", exact: true })
      .isEnabled(),
    false,
  );
  const recoveryMeasurements = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    contentWidth: document.querySelector(".drama-content").clientWidth,
    scrollWidth: document.querySelector(".drama-content").scrollWidth,
  }));
  assert.ok(
    recoveryMeasurements.documentWidth <= 640 &&
      recoveryMeasurements.scrollWidth <= recoveryMeasurements.contentWidth + 1,
  );
  await page.locator(".drama-main").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: join(output, "recovery-narrow.png") });
  checks.push({
    name: "cold-pending-narrow",
    width: 640,
    height: 900,
    mode: "dark",
    measurements: recoveryMeasurements,
    sameOriginalDraft: true,
    automaticWrites: 0,
  });
  assert.deepEqual(errors, []);
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((yes, no) =>
    server.close((error) => (error ? no(error) : yes())),
  );
}
await writeFile(
  join(output, "visual-verification.json"),
  JSON.stringify(
    {
      fixture: "public DTO server; not production identity/SQL",
      package: descriptor.version,
      packageFiles: descriptor.files,
      conversationCalls,
      actualRunsCreated: 0,
      checks,
      errors,
      browserClosed: true,
      serverClosed: true,
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(
  `${checks.length} viewports inspected; browser/server physically closed\n`,
);
