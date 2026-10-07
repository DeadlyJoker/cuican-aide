import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import { persistentProps } from "./persistent-ui.test-support.mjs";
import { textService } from "./text-ui.test-support.mjs";
import { mediaInputFixture } from "./media-input.test-support.mjs";
import { assetControllerFixture } from "./asset-controller.test-support.mjs";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(
    `../dist/${process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "26.0.0"}/`,
    import.meta.url,
  ).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
const page = (f, id) =>
  f.container.querySelector(`[data-project-page="${id}"]`);
const field = (f, label) =>
  f.container.querySelector(
    `input[aria-label="${label}"], textarea[aria-label="${label}"]`,
  );
const episode = (f) =>
  [...f.container.querySelectorAll(".story-script-workbench button")].find(
    (b) => b.textContent.startsWith("第 1 集 ·"),
  );
async function open(services) {
  const f = fixture(definition, { props: persistentProps(true), services });
  await settle();
  await f.click(f.container.querySelector(".project-card"));
  return f;
}

function assetPageService() {
  const media = mediaInputFixture();
  const recovery = assetControllerFixture().recovery;
  const calls = [];
  return {
    calls,
    services: {
      async invoke(action, input, options) {
        calls.push({ action, input });
        if (action.startsWith("crewon.project-asset-recovery.v2."))
          return recovery[action.split(".").at(-1)](input, options);
        return media.services.invoke(action, input, options);
      },
    },
  };
}

test("outline and script are separate pages over the same adopted sources and preserve both unsaved drafts", async () => {
  const service = textService();
  service.metadata.create("雨夜来信", "两集悬疑，先讨论人物。");
  const f = await open(service.services);
  try {
    await f.click(page(f, "script"));
    assert.equal(page(f, "script").getAttribute("aria-current"), "page");
    assert.equal(field(f, "故事梗概"), null);
    assert.match(f.container.textContent, /先保存并采用故事大纲/);
    await f.click(page(f, "outline"));
    await f.input(field(f, "一句话故事"), "一封信引出一段旧案。");
    await f.input(field(f, "故事梗概"), "修复师寻找寄件人。");
    await f.click(f.button("添加一集"));
    await f.input(field(f, "第 1 集标题"), "雨夜车站");
    await f.input(field(f, "第 1 集故事"), "她在车站收到一封未寄出的信。");
    await f.click(f.button("保存候选版本"));
    await f.click(f.button("采用此版本"));
    const saved = [...service.artifacts.values()][0];
    assert.equal(saved.artifact.selectedContentRevision, 1);
    await f.click(episode(f));
    assert.equal(page(f, "script").getAttribute("aria-current"), "page");
    assert.equal(field(f, "故事梗概"), null);
    await f.click(f.button("添加场次"));
    await f.input(field(f, "第 1 场动作"), " 未保存的动作\n保留换行 ");
    await f.click(page(f, "outline"));
    await f.input(field(f, "故事梗概"), "未保存的新大纲");
    await f.click(page(f, "script"));
    await f.click(episode(f));
    assert.equal(field(f, "第 1 场动作").value, " 未保存的动作\n保留换行 ");
    assert.match(f.container.textContent, /大纲 v1/);
    f.instance.update(persistentProps(true, { "--text": "#eee" }, "dark"));
    await settle();
    assert.equal(field(f, "第 1 场动作").value, " 未保存的动作\n保留换行 ");
    await f.click(page(f, "outline"));
    assert.equal(field(f, "故事梗概").value, "未保存的新大纲");
    assert.equal(saved.revisions.length, 1);
    assert.equal(
      service.calls.filter((c) => c.method === "saveScriptCandidate").length,
      0,
    );
  } finally {
    await f.dispose();
  }
});

test("character and art pages filter shared assets while keeping an unsaved setting safe across navigation", async () => {
  const service = assetPageService();
  const f = await open(service.services);
  try {
    await f.click(page(f, "characters"));
    assert.equal(
      f.container.querySelectorAll('[aria-label="资产列表"] > button').length,
      2,
    );
    const assetNames = [
      ...f.container.querySelectorAll('[aria-label="资产列表"] > button'),
    ].map((button) => button.textContent);
    assert.equal(
      new Set(assetNames).size,
      2,
      "same-prefix IDs remain distinguishable",
    );
    assert.ok(f.button("新建角色"));
    assert.equal(
      [...f.container.querySelectorAll("button")].some(
        (b) => b.textContent === "新建场景",
      ),
      false,
    );
    await f.click(f.button("新建角色"));
    await f.input(field(f, "资产名称"), "未保存的女主");
    await f.input(field(f, "资产设定"), "修复师，正在追查过去。");
    await f.click(page(f, "art"));
    assert.equal(
      f.container.querySelectorAll('[aria-label="资产列表"] > button').length,
      1,
    );
    assert.equal(field(f, "资产名称"), null);
    assert.equal(f.button("新建场景").disabled, true);
    assert.equal(f.button("新建道具").disabled, true);
    assert.match(f.container.textContent, /另一个页面有未保存的角色设定/);
    await f.click(f.button("返回继续编辑"));
    assert.equal(page(f, "characters").getAttribute("aria-current"), "page");
    assert.equal(field(f, "资产名称").value, "未保存的女主");
    assert.equal(field(f, "资产设定").value, "修复师，正在追查过去。");
    assert.equal(
      service.calls.some((c) => /save|submit|createPlan/.test(c.action)),
      false,
    );
  } finally {
    await f.dispose();
  }
});

test("art owns scene drafts and theme changes preserve the selected object page", async () => {
  const service = assetPageService();
  const f = await open(service.services);
  try {
    await f.click(page(f, "art"));
    await f.click(f.button("新建场景"));
    await f.input(field(f, "资产名称"), "雨夜车站");
    f.instance.update(persistentProps(true, { "--surface": "#222" }, "dark"));
    await settle();
    assert.equal(page(f, "art").getAttribute("aria-current"), "page");
    assert.equal(field(f, "资产名称").value, "雨夜车站");
    await f.click(page(f, "characters"));
    assert.equal(f.button("新建角色").disabled, true);
    await f.click(f.button("返回继续编辑"));
    assert.equal(page(f, "art").getAttribute("aria-current"), "page");
    assert.equal(field(f, "资产名称").value, "雨夜车站");
    assert.equal(page(f, "delivery"), null);
  } finally {
    await f.dispose();
  }
});
