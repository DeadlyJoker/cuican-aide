import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  browser,
  closedDialogs,
  fixture,
  props,
  settle,
} from "./ui.test-support.mjs";

const version = process.env.CREWON_EXAMPLE_PLUGIN_VERSION ?? "20.0.2";
const packageDirectory =
  process.env.CREWON_SHORT_DRAMA_TEST_PACKAGE_DIRECTORY ??
  new URL("../dist/" + version + "/", import.meta.url).pathname;
const { default: definition } = await import(
  pathToFileURL(join(packageDirectory, "ui.mjs")).href
);
after(async () => browser.happyDOM.close());

test("ships a unified self-contained UI and execution package with the original locally scoped stylesheet", async () => {
  const descriptor = JSON.parse(
    await readFile(join(packageDirectory, "crewon.plugin.json"), "utf8"),
  );
  assert.equal(descriptor.pluginId, "crewon.short-drama");
  assert.equal(definition.pluginId, descriptor.pluginId);
  assert.equal(descriptor.entrypoints.node, "node.mjs");
  assert.equal(descriptor.businessManifestPath, "business.json");
  assert.deepEqual(descriptor.requires, [
    ...(Number(version.split(".")[0]) >= 23
      ? [
          {
            service: "crewon.project-media-input-tools",
            apiVersion: "1",
            optional: true,
          },
        ]
      : []),
    ...(Number(version.split(".")[0]) >= 22
      ? [
          {
            service: "crewon.project-media-inputs",
            apiVersion: "1",
            optional: true,
          },
        ]
      : []),
    ...(Number(version.split(".")[0]) >= 21
      ? [
          {
            service: "crewon.project-media-execution",
            apiVersion: "1",
            optional: true,
          },
        ]
      : []),
    ...(Number(version.split(".")[0]) >= 19
      ? [
          "crewon.project-assets",
          "crewon.project-asset-recovery",
          "crewon.project-asset-tools",
          "crewon.project-asset-context",
          "crewon.project-asset-stages",
        ].map((service) => ({ service, apiVersion: "1", optional: true }))
      : []),
    ...(Number(version.split(".")[0]) >= 18
      ? [
          {
            service: "crewon.project-planning-drafts",
            apiVersion: "1",
            optional: true,
          },
          {
            service: "crewon.project-historical-queries",
            apiVersion: "1",
            optional: true,
          },
        ]
      : []),
    ...(Number(version.split(".")[0]) >= 17
      ? [
          {
            service: "crewon.project-text-plans",
            apiVersion: "1",
            optional: true,
          },
        ]
      : []),
    ...(Number(version.split(".")[0]) >= 20
      ? [
          {
            service: "crewon.project-conversation-association",
            apiVersion: "1",
            optional: true,
          },
        ]
      : []),
    ...(Number(version.split(".")[0]) >= 16
      ? [
          {
            service: "crewon.project-conversations",
            apiVersion: "1",
            optional: true,
          },
          {
            service: "crewon.project-context",
            apiVersion: "1",
            optional: true,
          },
        ]
      : []),
    ...(Number(version.split(".")[0]) >= 15
      ? [
          {
            service: "crewon.project-text-recovery",
            apiVersion: "1",
            optional: true,
          },
        ]
      : []),
    ...(Number(version.split(".")[0]) >= 14
      ? [{ service: "crewon.project-texts", apiVersion: "1", optional: true }]
      : []),
    { service: "crewon.creative-projects", apiVersion: "1", optional: true },
    { service: "crewon.plugin-ui-recovery", apiVersion: "1", optional: true },
    {
      service: "crewon.project-generation-reads",
      apiVersion: "1",
      optional: true,
    },
    { service: "crewon.project-generations", apiVersion: "1", optional: true },
    {
      service: "crewon.project-generation-queries",
      apiVersion: "1",
      optional: true,
    },
    {
      service: "crewon.project-generation-selections",
      apiVersion: "1",
      optional: true,
    },
    {
      service: "crewon.project-generation-contexts",
      apiVersion: "1",
      optional: true,
    },
    { service: "crewon.tasks", apiVersion: "2", optional: true },
    { service: "crewon.execution", apiVersion: "1", optional: true },
    ...(Number(version.split(".")[0]) >= 13
      ? [{ service: "crewon.project-tools", apiVersion: "1", optional: true }]
      : []),
  ]);
  assert.deepEqual(descriptor.provides, [
    { service: "crewon.short-drama", apiVersion: "1" },
  ]);
  assert.deepEqual(descriptor.contributions, [
    { id: "workbench", kind: "module", slot: "main.content", title: "AI 短剧" },
  ]);
  assert.equal(
    descriptor.files.filter((file) => file.path.endsWith(".png")).length,
    1,
  );
  for (const file of descriptor.files) {
    const bytes = await readFile(join(packageDirectory, file.path));
    assert.equal(bytes.byteLength, file.byteLength);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
  const css = await readFile(
    new URL("../src/workbench/ShortDramaWorkbenchPreview.css", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    css,
    /(?:^|\n)\s*(?:body|html|:root|\.command-|\.screen-shell)/u,
  );
  assert.doesNotMatch(css, /position:\s*fixed|100[ds]?vh/u);
  assert.match(css, /font-family: inherit/u);
  const f = fixture(definition);
  try {
    assert.equal(f.container.querySelector("style").textContent, css);
    assert.equal(f.container.querySelectorAll(".project-card").length, 3);
    assert.match(f.container.textContent, /不实际扣费/u);
    assert.match(f.container.textContent, /离开模块后重开会重置演示数据/u);
    assert.equal(f.container.querySelector("aside"), null);
    assert.equal(f.container.querySelector(".sidebar-account"), null);
    assert.equal(f.container.querySelector(".command-window"), null);
    const image = f.container.querySelector("img");
    assert.ok(
      image.src.startsWith(pathToFileURL(packageDirectory + "/assets/").href),
    );
  } finally {
    await f.dispose();
  }
});

test("preserves concept versions, simulated generation, selection, history and settings with zero task or fetch calls", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("demo_must_not_fetch");
  };
  const f = fixture(definition);
  try {
    await f.click(f.container.querySelector(".project-card"));
    assert.equal(
      f.container.querySelector(".page-heading h1").textContent,
      "窗边的来信",
    );
    await f.click(f.button("生成新版本"));
    assert.match(
      f.container.querySelector(".breadcrumbs").textContent,
      /概念图 v3/u,
    );
    await f.click(f.button("开始生成"));
    assert.match(
      f.container.querySelector(".status-stack").textContent,
      /排队中/u,
    );
    await f.click(f.button("查询原任务"));
    await f.click(f.button("设为选用"));
    assert.equal(f.button("已设为选用").disabled, true);
    await f.click(f.button("查看生成记录"));
    assert.equal(f.container.querySelector("dialog").open, true);
    assert.match(
      f.container.querySelector("dialog").textContent,
      /概念图修订 v3/u,
    );
    await f.click(f.container.querySelector('[aria-label="关闭弹窗"]'));
    await f.click(f.button("生成服务设置"));
    assert.match(
      f.container.querySelector("dialog").textContent,
      /本预览不会调用/u,
    );
    await f.click(f.container.querySelector('[aria-label="关闭弹窗"]'));
    await f.click(f.button("返回项目"));
    assert.equal(f.container.querySelectorAll(".revision-item").length, 3);
    await f.click(f.button("v2"));
    assert.match(f.container.querySelector("dialog").textContent, /需求 v1/u);
    assert.match(f.container.querySelector("dialog").textContent, /需求 v2/u);
    await f.click(f.container.querySelector('[aria-label="关闭弹窗"]'));
    await f.click(f.button("AI 短剧"));
    assert.equal(f.container.querySelectorAll(".project-card").length, 3);
    assert.equal(f.serviceCalls, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await f.dispose();
  }
});

test("creates and filters a demo project, retains brief revisions, and enforces archived editing controls", async () => {
  const f = fixture(definition);
  try {
    await f.click(f.button("新建项目"));
    await f.input(f.container.querySelector("dialog input"), "独立页面故事");
    await f.input(
      f.container.querySelector("dialog textarea"),
      "一封保留原始输入的信。",
    );
    await f.click(f.button("创建项目"));
    assert.equal(
      f.container.querySelector(".page-heading h1").textContent,
      "独立页面故事",
    );
    await f.input(
      f.container.querySelector("#creative-brief"),
      "温暖的故事，需求第二版。",
    );
    await f.click(f.button("保存为新版本"));
    await f.click(f.button("v2"));
    assert.match(
      f.container.querySelector("dialog").textContent,
      /一封保留原始输入的信/u,
    );
    assert.match(
      f.container.querySelector("dialog").textContent,
      /温暖的故事/u,
    );
    await f.click(f.container.querySelector('[aria-label="关闭弹窗"]'));
    await f.click(f.button("创建概念图"));
    await f.click(f.button("开始生成"));
    await f.click(f.button("返回项目"));
    await f.click(f.button("归档项目"));
    await f.click(f.button("已归档"));
    assert.equal(f.container.querySelectorAll(".project-card").length, 1);
    await f.input(
      f.container.querySelector('[aria-label="搜索项目名称"]'),
      "独立页面",
    );
    await f.click(f.container.querySelector(".project-card"));
    assert.equal(f.container.querySelector("#creative-brief").disabled, true);
    assert.equal(f.button("生成新版本").disabled, true);
    await f.click(f.container.querySelector(".concept-art"));
    await f.click(f.button("查询原任务"));
    assert.equal(f.button("设为选用").disabled, true);
    await f.click(f.button("返回项目"));
    await f.click(f.button("恢复项目"));
    await f.click(f.container.querySelector(".filter-tabs button"));
    await f.input(
      f.container.querySelector('[aria-label="搜索项目名称"]'),
      "独立页面",
    );
    assert.equal(f.container.querySelectorAll(".project-card").length, 1);
    assert.equal(f.serviceCalls, 0);
  } finally {
    await f.dispose();
  }
});

test("updates only owned theme tokens while preserving input and original host DOM", async () => {
  const f = fixture(definition);
  const sentinel = document.createElement("aside");
  sentinel.className = "original-account-and-navigation";
  sentinel.textContent = "原用户栏与设置";
  document.body.prepend(sentinel);
  const rootStyle = document.documentElement.getAttribute("style");
  const rootTheme = document.documentElement.dataset.theme;
  try {
    await f.click(f.container.querySelector(".project-card"));
    await f.input(
      f.container.querySelector("#creative-brief"),
      "未保存的页面输入",
    );
    const textarea = f.container.querySelector("#creative-brief");
    const owner = f.container.querySelector("[data-short-drama-plugin]");
    f.instance.update(props({ "--surface": "#181818" }, "dark"));
    assert.equal(f.container.querySelector("#creative-brief"), textarea);
    assert.equal(textarea.value, "未保存的页面输入");
    assert.equal(owner.dataset.theme, "dark");
    assert.equal(owner.style.getPropertyValue("--surface"), "#181818");
    assert.equal(owner.style.getPropertyValue("--text"), "");
    assert.equal(document.documentElement.getAttribute("style"), rootStyle);
    assert.equal(document.documentElement.dataset.theme, rootTheme);
    assert.equal(sentinel.textContent, "原用户栏与设置");
    assert.throws(
      () =>
        f.instance.update(
          props({ "--text": "changed", "color": "red" }, "light"),
        ),
      /short_drama_ui_theme_token_invalid/u,
    );
    assert.equal(owner.style.getPropertyValue("--surface"), "#181818");
    assert.equal(owner.dataset.theme, "dark");
  } finally {
    await f.dispose();
    assert.equal(sentinel.isConnected, true);
    sentinel.remove();
  }
});

test("closes native dialogs and clears notice timers on disposal, then remounts initial demo data", async () => {
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const notices = new Set();
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    const timer = originalTimeout(callback, milliseconds, ...args);
    if (milliseconds === 4000) notices.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    notices.delete(timer);
    return originalClear(timer);
  };
  const f = fixture(definition);
  try {
    await f.click(f.container.querySelector(".project-card"));
    await f.click(f.button("生成新版本"));
    assert.equal(notices.size, 1);
    await f.click(f.button("生成服务设置"));
    const dialog = f.container.querySelector("dialog");
    assert.equal(dialog.open, true);
    f.instance.dispose();
    await settle();
    assert.equal(dialog.open, false);
    assert.ok(closedDialogs.includes(dialog));
    assert.equal(notices.size, 0);
    assert.equal(f.container.children.length, 0);
    f.instance.dispose();
    assert.throws(() => f.instance.update(props()), /short_drama_ui_disposed/u);
    const next = definition.mount(f.container, props(), f.services);
    await settle();
    assert.equal(f.container.querySelectorAll(".project-card").length, 3);
    await f.click(f.container.querySelector(".project-card"));
    assert.equal(f.container.querySelectorAll(".revision-item").length, 2);
    next.dispose();
  } finally {
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClear;
    await f.dispose();
  }
});

test("handles dialog cancel/backdrop and disposes only its own generation", async () => {
  const f = fixture(definition);
  try {
    await f.click(f.button("新建项目"));
    const dialog = f.container.querySelector("dialog");
    const cancel = new browser.Event("cancel", { cancelable: true });
    dialog.dispatchEvent(cancel);
    await settle();
    assert.equal(cancel.defaultPrevented, true);
    assert.equal(dialog.open, false);
    await f.click(f.button("新建项目"));
    await f.click(dialog);
    assert.equal(dialog.open, false);
    const second = definition.mount(f.container, props(), f.services);
    await settle();
    const owners = f.container.querySelectorAll("[data-short-drama-plugin]");
    assert.equal(owners.length, 2);
    f.instance.dispose();
    assert.equal(owners[0].isConnected, false);
    assert.equal(owners[1].isConnected, true);
    assert.equal(owners[1].querySelectorAll(".project-card").length, 3);
    second.dispose();
    assert.equal(f.container.children.length, 0);
  } finally {
    await f.dispose();
  }
});

test("rejects the wrong contribution before changing any host DOM", () => {
  const root = document.createElement("div");
  const marker = document.createElement("span");
  root.append(marker);
  assert.throws(
    () => definition.mount(root, { ...props(), contributionId: "other" }, {}),
    /short_drama_ui_contribution_invalid/u,
  );
  assert.equal(root.children.length, 1);
  assert.equal(root.firstElementChild, marker);
});
