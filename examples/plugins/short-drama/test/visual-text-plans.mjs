import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { textPlanUiService } from "./text-plan-ui.test-support.mjs";

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
let service = textPlanUiService();
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
      response.end(
        JSON.stringify(await service.services.invoke(action, input)),
      );
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
    service = textPlanUiService();
    await page.setViewportSize({ width, height });
    await page.goto(`${address}/?mode=${mode}`);
    await page.locator(".project-card").first().click();
    const panel = page.getByRole("region", {
      name: "文字自动执行计划",
      exact: true,
    });
    await page
      .getByLabel("计划使用的项目对话", { exact: true })
      .selectOption("fixture-thread");
    await page.getByLabel("计划集数", { exact: true }).selectOption("2");
    await page
      .getByLabel("计划创作要求", { exact: true })
      .fill("保留人物动机，编写两集都市悬疑的大纲与剧本，每集结尾有悬念。");
    await page
      .getByRole("button", { name: "开始文字计划", exact: true })
      .click();
    await page.getByLabel("当前计划进度", { exact: true }).waitFor();
    assert.equal(
      service.calls.filter((c) => c.action.endsWith(".start")).length,
      1,
    );
    assert.equal(service.view.definition.adoption, "manual");
    await page.getByRole("button", { name: "暂停计划", exact: true }).click();
    await page.getByText("你暂停了这个计划", { exact: false }).waitFor();
    await panel.evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    const measure = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      contentWidth: document.querySelector(".drama-content").clientWidth,
      scrollWidth: document.querySelector(".drama-content").scrollWidth,
      scrollerHeight: document.querySelector(".drama-main").clientHeight,
      scrollerContent: document.querySelector(".drama-main").scrollHeight,
      stageCount: document.querySelectorAll(".stage-item").length,
    }));
    assert.ok(measure.documentWidth <= width);
    assert.ok(measure.scrollWidth <= measure.contentWidth + 1);
    assert.equal(measure.stageCount, 5);
    await page.screenshot({ path: join(output, `plan-${name}.png`) });
    await page
      .getByLabel("当前计划进度", { exact: true })
      .evaluate((element) => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: join(output, `progress-${name}.png`) });
    checks.push({
      name,
      width,
      height,
      mode,
      measure,
      fixtureOnly: true,
      actualRunsCreated: 0,
    });
  }
  service = textPlanUiService();
  await page.setViewportSize({ width: 640, height: 900 });
  await page.goto(`${address}/?mode=light`);
  await page.locator(".project-card").first().click();
  await page
    .getByLabel("计划使用的项目对话", { exact: true })
    .selectOption("fixture-thread");
  await page
    .getByLabel("计划创作要求", { exact: true })
    .fill("先生成两集大纲和剧本。");
  service.loseNextAck();
  await page.getByRole("button", { name: "开始文字计划", exact: true }).click();
  await page
    .getByRole("button", { name: "重试原计划操作", exact: true })
    .waitFor();
  const starts = service.calls.filter((c) => c.action.endsWith(".start"));
  assert.equal(starts.length, 1);
  await page
    .getByRole("region", { name: "文字自动执行计划", exact: true })
    .evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: join(output, "unknown-plan-narrow.png") });
  await page
    .getByRole("button", { name: "重试原计划操作", exact: true })
    .click();
  await page.getByLabel("当前计划进度", { exact: true }).waitFor();
  assert.deepEqual(
    service.calls.filter((c) => c.action.endsWith(".start"))[1].input,
    starts[0].input,
  );
  const writes = service.calls.filter(
    (c) => !c.action.endsWith(".get") && !c.action.endsWith(".list"),
  ).length;
  await page.reload();
  await page.locator(".project-card").first().click();
  await page.getByRole("button", { name: "查看计划", exact: true }).waitFor();
  assert.equal(
    service.calls.filter(
      (c) => !c.action.endsWith(".get") && !c.action.endsWith(".list"),
    ).length,
    writes,
  );
  checks.push({
    name: "same-key-retry-and-cold-read",
    width: 640,
    height: 900,
    automaticWrites: 0,
    fixtureOnly: true,
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
      fixture:
        "named public DTO ledger, no production identity/Thread/Run/model",
      package: descriptor.version,
      packageFiles: descriptor.files,
      checks,
      errors,
      browserClosed: true,
      serverClosed: true,
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);
process.stdout.write(
  `${checks.length} plan scenarios inspected; browser/server physically closed\n`,
);
