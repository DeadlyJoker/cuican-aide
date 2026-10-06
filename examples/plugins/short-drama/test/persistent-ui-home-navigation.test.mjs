import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { browser, fixture, settle } from "./ui.test-support.mjs";
import {
  metadataService,
  persistentProps,
} from "./persistent-ui.test-support.mjs";

const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "26.0.0";
const directory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL(`../dist/${version}/`, import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(directory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());
async function ready(service) {
  const f = fixture(definition, {
    props: persistentProps(true),
    services: service.services,
  });
  await settle();
  return f;
}
async function snapshot(name, html) {
  const file = new URL(`./snapshots/${name}.html`, import.meta.url);
  if (process.env.CREWON_UPDATE_PROJECT_HOME_SNAPSHOTS === "1")
    await writeFile(file, html + "\n");
  assert.equal(html, (await readFile(file, "utf8")).trimEnd());
}

test("home reviews an exact idea before a single original project write and retains it across cancellation and theme changes", async () => {
  const service = metadataService(),
    f = await ready(service);
  try {
    await snapshot(
      "project-home",
      f.container.querySelector(".drama-project-home").outerHTML,
    );
    const idea = "  雨夜来信\n三集悬疑，先讨论角色。  ";
    await f.input(f.container.querySelector("#drama-project-idea"), idea);
    await f.click(f.button("确认创作需求"));
    assert.equal(service.methodCalls("createProject").length, 0);
    assert.equal(f.container.querySelector("dialog input").value, "雨夜来信");
    assert.equal(f.container.querySelector("dialog textarea").value, idea);
    await f.click(f.button("取消"));
    f.instance.update(persistentProps(true, { "--text": "#eeeeee" }, "dark"));
    await settle();
    assert.equal(f.container.querySelector("#drama-project-idea").value, idea);
    await f.click(f.button("确认创作需求"));
    await f.click(f.button("创建项目"));
    assert.equal(service.methodCalls("createProject").length, 1);
    assert.equal(service.records.size, 1);
    assert.equal([...service.records.values()][0].briefs[0].text, idea);
    assert.equal(f.container.querySelector("#creative-brief").value, idea);
    assert.equal(
      service.calls.some((c) =>
        /generation|startStage|createPlan/.test(c.action),
      ),
      false,
    );
    await f.click(f.button("AI 短剧"));
    assert.equal(f.container.querySelector("#drama-project-idea").value, "");
    assert.equal(f.container.querySelectorAll(".project-card").length, 1);
  } finally {
    await f.dispose();
  }
});

test("home keyboard shortcut only reviews a bounded idea and plain Enter remains a newline", async () => {
  const service = metadataService(),
    f = await ready(service);
  try {
    const input = f.container.querySelector("#drama-project-idea");
    await f.input(input, "中文".repeat(1500));
    input.dispatchEvent(
      new browser.KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();
    assert.equal(f.container.querySelector("dialog").open, false);
    assert.equal(f.button("确认创作需求").disabled, true);
    await f.input(input, "一个镜头\n先确认");
    input.dispatchEvent(
      new browser.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();
    assert.equal(f.container.querySelector("dialog").open, false);
    input.dispatchEvent(
      new browser.KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();
    assert.equal(f.container.querySelector("dialog").open, true);
    assert.equal(
      f.container.querySelector("dialog textarea").value,
      "一个镜头\n先确认",
    );
    assert.equal(service.methodCalls("createProject").length, 0);
  } finally {
    await f.dispose();
  }
});

test("internal navigation can collapse without replacing the project, losing drafts or touching the host theme", async () => {
  const service = metadataService();
  service.create("目录验收", "原需求");
  const hostStyle = document.documentElement.getAttribute("style");
  const f = await ready(service);
  try {
    await f.click(f.container.querySelector(".project-card"));
    await f.input(
      f.container.querySelector("#creative-brief"),
      "保留未保存的需求",
    );
    const before = service.calls.length;
    const nav = f.container.querySelector('[aria-label="创作阶段"]');
    await snapshot(
      "project-navigation",
      nav.outerHTML.replace(/(?:id|aria-controls)="[^"]+"/gu, (value) =>
        value.startsWith("id=")
          ? 'id="project-navigation"'
          : 'aria-controls="project-navigation"',
      ),
    );
    await f.click(nav.querySelector('[aria-label="收起项目目录"]'));
    assert.equal(
      f.container.querySelector(".drama-project-layout").dataset
        .navigationExpanded,
      "false",
    );
    assert.equal(
      f.container.querySelector("#creative-brief").value,
      "保留未保存的需求",
    );
    assert.equal(service.calls.length, before);
    f.instance.update(persistentProps(true, { "--text": "#eeeeee" }, "dark"));
    await settle();
    assert.equal(
      f.container.querySelector(".drama-project-layout").dataset
        .navigationExpanded,
      "false",
    );
    await f.click(nav.querySelector('[aria-label="展开项目目录"]'));
    assert.equal(
      f.container.querySelector(".drama-project-layout").dataset
        .navigationExpanded,
      "true",
    );
    assert.equal(
      nav
        .querySelector('[aria-label="项目与概念图"]')
        .getAttribute("aria-current"),
      "page",
    );
    assert.equal(nav.querySelector('[aria-label="视频与成片"]').disabled, true);
    assert.equal(document.documentElement.getAttribute("style"), hostStyle);
    assert.equal(f.container.querySelector(".command-sidebar"), null);
  } finally {
    await f.dispose();
  }
});

test("recent projects still use returned pages, search only loaded records, and keep archived selection", async () => {
  const service = metadataService({ pageSize: 2 });
  for (let i = 0; i < 5; i++) service.create(`短剧 ${i}`, "需求");
  const f = await ready(service);
  try {
    assert.equal(f.container.querySelectorAll(".project-card").length, 2);
    await f.click(f.button("加载更多项目"));
    assert.equal(f.container.querySelectorAll(".project-card").length, 4);
    await f.input(
      f.container.querySelector('[aria-label="搜索已加载项目名称"]'),
      "不存在",
    );
    assert.equal(f.container.querySelectorAll(".project-card").length, 0);
    assert.match(f.container.textContent, /已加载项目中没有这个名称/);
    await f.input(
      f.container.querySelector('[aria-label="搜索已加载项目名称"]'),
      "",
    );
    await f.click(f.container.querySelector(".project-card"));
    await f.click(f.button("归档项目"));
    await f.click(f.button("AI 短剧"));
    await f.click(f.button("已归档"));
    assert.equal(f.button("已归档").getAttribute("aria-pressed"), "true");
    assert.equal(f.container.querySelectorAll(".project-card").length, 1);
    await f.click(f.container.querySelector(".project-card"));
    assert.equal(f.container.querySelector("#creative-brief").disabled, true);
    assert.equal(service.methodCalls("createProject").length, 0);
  } finally {
    await f.dispose();
  }
});

test("project dialogs keep the host interactive and preserve focus ownership on cancellation and disposal", async () => {
  const service = metadataService();
  const host = document.createElement("button");
  host.textContent = "原宿主侧栏";
  document.body.prepend(host);
  let hostClicks = 0;
  host.addEventListener("click", () => hostClicks++);
  const modal = browser.HTMLDialogElement.prototype.showModal;
  browser.HTMLDialogElement.prototype.showModal = () => {
    throw new Error("plugin_must_not_enter_host_top_layer");
  };
  const f = await ready(service);
  try {
    await f.input(f.container.querySelector("#drama-project-idea"), "保留故事");
    const opener = f.button("确认创作需求");
    opener.focus();
    await f.click(opener);
    const dialog = f.container.querySelector("dialog");
    assert.equal(dialog.open, true);
    assert.ok(document.activeElement === dialog.querySelector("input"));
    assert.equal(f.container.querySelector(".drama-main").inert, true);
    assert.equal(host.closest("[inert]"), null);
    assert.equal(document.body.inert, false);
    await f.click(host);
    assert.equal(hostClicks, 1);
    const field = dialog.querySelector("input");
    field.focus();
    field.dispatchEvent(
      new browser.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();
    assert.equal(dialog.open, false);
    assert.equal(f.container.querySelector(".drama-main").inert, false);
    assert.ok(document.activeElement === opener, "cancel restores the opener");
    assert.equal(
      f.container.querySelector("#drama-project-idea").value,
      "保留故事",
    );
    assert.equal(service.methodCalls("createProject").length, 0);
    await f.click(opener);
    host.focus();
    await f.dispose();
    assert.equal(dialog.open, false);
    assert.ok(document.activeElement === host, "disposal preserves host focus");
    assert.equal(host.isConnected, true);
  } finally {
    await f.dispose();
    browser.HTMLDialogElement.prototype.showModal = modal;
    host.remove();
  }
});
