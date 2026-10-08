import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import {
  foundationProps,
  foundationService,
} from "./foundation-ui.test-support.mjs";
import { sourceUploadFixture } from "./source-upload-ui.test-support.mjs";
import { persistentProps } from "./persistent-ui.test-support.mjs";
const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "39.0.0";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(`../dist/${version}/`, import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
async function ready(service, props = foundationProps()) {
  const f = fixture(definition, { props, services: service.services });
  await settle();
  return f;
}
async function snapshot(name, html) {
  const file = new URL(`./snapshots/${name}.html`, import.meta.url);
  if (process.env.CREWON_UPDATE_PROJECT_HOME_SNAPSHOTS === "1")
    await writeFile(file, html + "\n");
  assert.equal(html, (await readFile(file, "utf8")).trimEnd());
}
const navigationHtml = (f) =>
  f.container
    .querySelector(".drama-project-navigation")
    .outerHTML.replace(/(?:id|aria-controls)="[^"]+"/gu, (value) =>
      value.startsWith("id=")
        ? 'id="project-navigation"'
        : 'aria-controls="project-navigation"',
    );
const field = (root, label, selector = "input") =>
  [...root.querySelectorAll("label")]
    .find((element) => element.textContent.startsWith(label))
    ?.querySelector(selector);
async function select(f, element, value) {
  assert.ok(element);
  element.value = value;
  element.dispatchEvent(new browser.Event("change", { bubbles: true }));
  await settle();
}
async function open(f, title) {
  await f.click(
    [...f.container.querySelectorAll(".project-card")].find(
      (card) => card.querySelector("h2")?.textContent === title,
    ),
  );
  await settle();
}

test("creative entry keeps all parameters across review/cancel/theme and writes the actual Foundation API once", async () => {
  const service = foundationService(),
    f = await ready(service);
  try {
    await snapshot(
      "foundation-home",
      f.container.querySelector(".drama-project-home").outerHTML,
    );
    await f.input(
      f.container.querySelector("#drama-project-idea"),
      "未来来信\n悬疑三集",
    );
    await f.input(field(f.container, "参考文字", "textarea"), "雨夜写实风格");
    await select(f, field(f.container, "作品形式", "select"), "series");
    await f.input(field(f.container, "总集数"), "3");
    await select(f, field(f.container, "画面比例", "select"), "9:16");
    await f.click(f.button("确认创作需求"));
    const modal = f.container.querySelector(".drama-creation-modal");
    await snapshot("foundation-creation", modal.outerHTML);
    assert.ok(modal.open);
    assert.equal(f.container.querySelector(".drama-main").inert, true);
    assert.equal(field(modal, "总集数").value, "3");
    await f.input(field(modal, "项目名称"), "未来来信·系列");
    await f.click(f.button("取消"));
    f.instance.update(foundationProps({ "--text": "#eeeeee" }, "dark"));
    await settle();
    await f.click(f.button("确认创作需求"));
    assert.equal(
      field(f.container.querySelector(".drama-creation-modal"), "项目名称")
        .value,
      "未来来信·系列",
    );
    await f.click(f.button("创建项目"));
    const input = service.methodCalls("createProject")[0].input;
    assert.equal(input.origin, "creative");
    assert.equal(input.parameters.episodeMode, "series");
    assert.equal(input.parameters.episodeCount, 3);
    assert.equal(input.parameters.aspectRatio, "9:16");
    assert.equal(input.creativeStartMode, "confirm-plan");
    assert.equal(input.sourceUpload, null);
    assert.equal(
      input.briefText,
      "未来来信\n悬疑三集\n\n参考文字：\n雨夜写实风格",
    );
    assert.equal(service.metadata.methodCalls("createProject").length, 0);
    await snapshot("foundation-creative-navigation", navigationHtml(f));
    assert.equal(
      f.container.querySelector('[data-project-page="outline"]'),
      null,
    );
    assert.equal(
      f.container.querySelector('[data-project-page="source"]'),
      null,
    );
    assert.ok(f.container.querySelector('section[aria-label="创作方案"]'));
    assert.equal(
      service.calls.some((c) =>
        /generation|startStage|createConversation/.test(c.action),
      ),
      false,
    );
  } finally {
    await f.dispose();
  }
});

test("proposal body, edit, save and confirm are visible and parameter changes invalidate confirmation without hiding history", async () => {
  const service = foundationService();
  const created = service.seed("creative");
  const f = await ready(service);
  try {
    await open(f, created.project.title);
    await f.click(f.button("填写方案"));
    const body = field(f.container, "方案正文", "textarea");
    await f.input(
      body,
      "雨夜接到未来来信，三集分别寻找信件来源、调查失踪、揭开真相。",
    );
    await f.click(f.button("保存方案"));
    assert.equal(service.methodCalls("saveProposal").length, 1);
    assert.match(
      f.container.querySelector('section[aria-label="创作方案"]').textContent,
      /三集分别寻找/,
    );
    assert.equal(f.button("确认方案").disabled, false);
    await snapshot(
      "foundation-proposal",
      f.container.querySelector(".drama-foundation-workbench").outerHTML,
    );
    await f.click(f.button("确认方案"));
    assert.equal(service.methodCalls("confirmProposal").length, 1);
    assert.equal(f.button("方案已确认").disabled, true);
    await f.click(f.button("编辑参数"));
    await f.input(
      field(f.container.querySelector(".drama-foundation-workbench"), "题材"),
      "悬疑",
    );
    await f.click(f.button("保存参数"));
    assert.equal(
      service.foundations.get(created.project.projectId).confirmedProposal,
      null,
    );
    assert.equal(f.button("确认方案").disabled, true);
    assert.match(f.container.textContent, /创作条件或原文已变化/);
    assert.equal(service.proposals.get(created.project.projectId).length, 1);
  } finally {
    await f.dispose();
  }
});

test("novel navigation separates chapter source from outline and reads scalar bounded actual pages", async () => {
  const service = foundationService(),
    created = service.seed("novel"),
    f = await ready(service);
  try {
    await open(f, created.project.title);
    assert.equal(
      f.container
        .querySelector('[data-project-page="outline"]')
        .textContent.includes("改编大纲"),
      true,
    );
    await snapshot("foundation-novel-navigation", navigationHtml(f));
    await f.click(f.container.querySelector('[data-project-page="source"]'));
    assert.match(
      f.container.querySelector(".drama-source-body").textContent,
      /雨😀夜/,
    );
    assert.equal(service.methodCalls("readSourcePage")[0].input.limit, 1024);
    await snapshot(
      "foundation-source",
      f.container.querySelector(".drama-source-reader").outerHTML,
    );
    await f.click(f.button("第二章 寻人"));
    const actual = service.methodCalls("readSourcePage").at(-1).input;
    assert.equal(
      actual.startOffset,
      service.sources.get(created.project.projectId).chapters[1].startOffset,
    );
    assert.equal(
      Array.from(
        f.container.querySelector(".drama-source-body .drama-readable-text")
          .textContent,
      ).length,
      1024,
    );
    await f.click(f.button("下一页原文"));
    assert.equal(
      service.methodCalls("readSourcePage").at(-1).input.startOffset,
      actual.startOffset + 1024,
    );
    assert.equal(
      f.container
        .querySelector('[data-project-page="source"]')
        .getAttribute("aria-current"),
      "page",
    );
    assert.equal(service.metadata.methodCalls("createProject").length, 0);
  } finally {
    await f.dispose();
  }
});

test("missing raw upload explicitly disables novel creation, and an old Host never receives a Foundation write", async () => {
  const service = foundationService(),
    f = await ready(service, persistentProps(true));
  try {
    await f.click(f.button("从小说创建短剧"));
    assert.match(
      f.container.querySelector(".drama-creation-modal").textContent,
      /尚未接入小说文件上传/,
    );
    assert.equal(f.button("创建项目").disabled, true);
    assert.equal(service.calls.length, 0);
    await f.click(f.button("取消"));
    await f.input(
      f.container.querySelector("#drama-project-idea"),
      "旧项目服务继续保存实际需求",
    );
    await f.click(f.button("确认创作需求"));
    await f.click(f.button("创建项目"));
    assert.equal(service.metadata.methodCalls("createProject").length, 1);
    assert.equal(service.calls.length, 0);
  } finally {
    await f.dispose();
  }
});

test("a lost Foundation create reply retries the exact original key and confirmed result opens the one existing project", async () => {
  const service = foundationService(),
    f = await ready(service);
  try {
    await f.input(
      f.container.querySelector("#drama-project-idea"),
      "保留原请求",
    );
    await f.click(f.button("确认创作需求"));
    service.loseNextReply();
    await f.click(f.button("创建项目"));
    assert.equal(f.button("取消").disabled, true);
    assert.equal(service.metadata.records.size, 1);
    await f.click(f.button("重试原保存请求"));
    const [first, second] = service.methodCalls("createProject");
    assert.deepEqual(first.input, second.input);
    assert.equal(service.metadata.records.size, 1);
    assert.equal(f.container.querySelector(".drama-creation-modal"), null);
    assert.ok(f.container.querySelector('section[aria-label="创作方案"]'));
  } finally {
    await f.dispose();
  }
});

test("a connected Host without a Foundation owner reports unavailable and never invents a saved project", async () => {
  const service = foundationService(),
    invoke = service.services.invoke;
  service.services.invoke = async (action, input, options) => {
    if (action.startsWith("crewon.project-foundation."))
      throw Object.assign(new Error("plugin_ui_service_unavailable"), {
        code: "plugin_ui_service_unavailable",
      });
    return invoke(action, input, options);
  };
  const f = await ready(service);
  try {
    await f.input(f.container.querySelector("#drama-project-idea"), "雨夜来信");
    await f.click(f.button("确认创作需求"));
    await f.click(f.button("创建项目"));
    assert.match(f.container.textContent, /创作服务暂不可用/);
    assert.equal(service.metadata.records.size, 0);
    assert.equal(service.metadata.methodCalls("createProject").length, 0);
    assert.equal(f.button("取消").disabled, false);
    assert.equal(
      [...f.container.querySelectorAll("button")].some(
        (button) => button.textContent === "重试原保存请求",
      ),
      false,
    );
    assert.ok(f.container.querySelector(".drama-creation-modal"));
  } finally {
    await f.dispose();
  }
});

test("latest proposal scanning stops at 64 bounded pages and continues before allowing save CAS", async () => {
  const service = foundationService(),
    created = service.seed("creative");
  for (let i = 0; i < 195; i++)
    service.proposal(created.project.projectId, `方案 ${i + 1}`);
  const f = await ready(service);
  try {
    await open(f, created.project.title);
    assert.equal(service.methodCalls("listProposals").length, 64);
    assert.match(
      f.container.querySelector('section[aria-label="创作方案"]').textContent,
      /方案 192/,
    );
    await f.click(f.button("编辑方案"));
    await f.input(field(f.container, "方案正文", "textarea"), "修改最终方案");
    assert.equal(f.button("保存方案").disabled, true);
    await f.click(f.button("继续读取方案记录"));
    assert.equal(service.methodCalls("listProposals").length, 65);
    assert.equal(f.button("保存方案").disabled, false);
    await f.click(f.button("保存方案"));
    assert.equal(
      service.methodCalls("saveProposal")[0].input.expectedProposalRevision,
      195,
    );
  } finally {
    await f.dispose();
  }
});

test("creative direct-script is an explicit persisted choice and never dispatches a model from the form", async () => {
  const service = foundationService(),
    f = await ready(service);
  try {
    await f.input(
      f.container.querySelector("#drama-project-idea"),
      "直接写单集剧本",
    );
    const direct = [...f.container.querySelectorAll("label")]
      .find((item) => item.textContent.includes("跳过方案确认"))
      ?.querySelector("input");
    await f.click(direct);
    await f.click(f.button("确认创作需求"));
    assert.equal(
      f.container.querySelector('input[name="creative-start"]:checked')
        .parentElement.textContent,
      "跳过方案，直接写剧本",
    );
    await f.click(f.button("创建项目"));
    assert.equal(
      service.methodCalls("createProject")[0].input.creativeStartMode,
      "direct-script",
    );
    assert.ok(f.button("进入剧本"));
    assert.equal(
      service.calls.some((c) => /generation|startStage/.test(c.action)),
      false,
    );
    assert.equal(
      service.metadata.calls.some((c) =>
        /generation|startStage/.test(c.action),
      ),
      false,
    );
  } finally {
    await f.dispose();
  }
});

test("mounted novel form sends native File bytes through the supplied SDK raw port and only creates after acknowledged ready", async () => {
  const raw = sourceUploadFixture();
  const service = foundationService({
    sourceForUpload: (id) => {
      assert.equal(id, raw.upload.uploadId);
      return Buffer.concat([...raw.parts.values()]).toString("utf8");
    },
  });
  const original = service.services.invoke;
  service.services = {
    invoke: (action, input, options) =>
      action.startsWith("crewon.project-source-uploads.")
        ? raw.services.invoke(action, input, options)
        : original(action, input, options),
    projectSourceUploads: raw.services.projectSourceUploads,
  };
  const f = await ready(service);
  try {
    await f.click(f.button("从小说创建短剧"));
    const modal = f.container.querySelector(".drama-creation-modal");
    assert.equal(modal.textContent.includes("尚未接入小说文件上传"), false);
    const file = new File(
      ["第一章 雨夜\n两人重逢。\n第二章 寻人\n寻找失踪的人。"],
      "雨夜.md",
    );
    const picker = modal.querySelector('input[type="file"]');
    // The DOM fixture's native input setter accepts this array; file bytes remain a real native File.
    picker.files = [file];
    picker.dispatchEvent(new browser.Event("change", { bubbles: true }));
    await settle();
    assert.equal(f.button("创建项目").disabled, true);
    await f.click(f.button("导入原文"));
    for (let i = 0; i < 30 && f.button("创建项目").disabled; i++)
      await settle();
    assert.equal(raw.upload.phase, "ready");
    assert.equal(raw.rawCalls.length, 1);
    assert.equal(service.methodCalls("createProject").length, 0);
    assert.equal(f.button("创建项目").disabled, false);
    await f.click(f.button("创建项目"));
    const actual = service.methodCalls("createProject")[0].input;
    assert.equal(actual.origin, "novel");
    assert.deepEqual(actual.sourceUpload, {
      uploadId: raw.upload.uploadId,
      fileDigest: raw.upload.fileDigest,
    });
    assert.equal(actual.parameters.adaptation.strategy, "core");
    assert.equal(
      raw.calls.some(
        (call) => "bytes" in call.input || "content" in call.input,
      ),
      false,
    );
    assert.ok(f.container.querySelector('[data-project-page="source"]'));
  } finally {
    await f.dispose();
  }
});
